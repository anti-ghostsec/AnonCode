//! FOCUS: decision-preserving context compression without training
//! (arXiv:2609.37590), as the first AnonCode adapted it.
//!
//! A conversation is cut into spans (a user message; an assistant message
//! with the tool results it produced). When the total is over the memory
//! budget:
//!
//! 1. A draft model plans the next steps several times; each plan cites the
//!    spans it depends on. How often a span is cited is its score.
//! 2. Spans scoring at least `tau` are kept.
//! 3. A defensive pass also keeps what can't be reconstructed or would be
//!    repeated if lost: errors, every user message, system spans, the most
//!    recent spans, and anything the draft model asked to rescue.
//! 4. Kept spans stay verbatim, in order. Nothing is summarised.
//! 5. Optionally, if still over a hard cap, spans are dropped until it
//!    fits: unprotected ones first, then older reviewer-loop messages, then
//!    older instructions, errors and rescues. The goal, the latest
//!    instruction, system spans and the recent spans are never dropped.
//!
//! Every decision is in the report, with its reasons.
//!
//! Without `cited`, the draft model is the offline heuristic (word overlap
//! with the task, recency, errors). The focus plugin, with a real model,
//! passes each rollout's citations in `cited` and the defensive review's
//! rescues in `rescued`.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
pub struct Span {
    pub id: String,
    /// `user_goal`, `user`, `loop` (a reviewer-loop message), `assistant`,
    /// `tool_result` or `system`.
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default, rename = "isError")]
    pub is_error: bool,
    /// Left out, it is estimated from `text` (about 4 characters a token).
    #[serde(default)]
    pub tokens: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct Options {
    /// Below this total, nothing is compressed.
    #[serde(rename = "memoryBudgetTokens")]
    pub memory_budget_tokens: u64,
    pub tau: f64,
    pub rollouts: u32,
    /// This many of the most recent spans are always kept.
    #[serde(rename = "keepRecent")]
    pub keep_recent: usize,
    #[serde(rename = "hardCapTokens")]
    pub hard_cap_tokens: Option<u64>,
}

impl Default for Options {
    fn default() -> Self {
        Options { memory_budget_tokens: 8000, tau: 0.3, rollouts: 3, keep_recent: 3, hard_cap_tokens: None }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Request {
    pub spans: Vec<Span>,
    #[serde(default)]
    pub task: String,
    #[serde(default)]
    pub options: Options,
    /// One list of cited span ids per rollout, from a real draft model.
    #[serde(default)]
    pub cited: Option<Vec<Vec<String>>>,
    /// Span ids the draft model's defensive review asked to keep.
    #[serde(default)]
    pub rescued: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Decision {
    pub id: String,
    pub kind: String,
    pub index: usize,
    pub tokens: u64,
    pub score: f64,
    pub kept: bool,
    #[serde(rename = "protected")]
    pub protected: bool,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Report {
    pub triggered: bool,
    #[serde(rename = "totalTokens")]
    pub total_tokens: u64,
    #[serde(rename = "keptTokens")]
    pub kept_tokens: u64,
    #[serde(rename = "keptCount")]
    pub kept_count: usize,
    #[serde(rename = "droppedCount")]
    pub dropped_count: usize,
    /// Ids of the spans to keep, in order.
    pub kept: Vec<String>,
    pub decisions: Vec<Decision>,
}

/// How strongly the defensive pass protects a span, weakest first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Level {
    None,
    /// A reviewer-loop message: each restates the mission, so older ones are the first protected spans to go.
    Loop,
    /// Older instructions, errors and draft-model rescues.
    Soft,
    /// The goal, the latest instruction, system parts and recent spans.
    Hard,
}

pub fn estimate_tokens(text: &str) -> u64 {
    (text.chars().count() as u64).div_ceil(4).max(1)
}

const STOP: &[&str] = &[
    "the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are", "was", "but", "not", "has", "have", "will", "can",
    "its",
];

fn keywords(text: &str) -> BTreeSet<String> {
    text.to_lowercase()
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| w.len() >= 3 && !STOP.contains(w))
        .map(str::to_string)
        .collect()
}

/// The offline draft model: the spans a plan for `task` would likely need.
/// The top half by score, plus every span sharing a word with the task.
pub fn heuristic_cited(spans: &[Span], task: &str) -> Vec<String> {
    if spans.is_empty() {
        return Vec::new();
    }
    let task_words = keywords(task);
    let mut scored: Vec<(usize, f64, usize)> = spans
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let overlap = keywords(&s.text).intersection(&task_words).count();
            let recency = if spans.len() <= 1 { 1.0 } else { i as f64 / (spans.len() - 1) as f64 };
            (i, overlap as f64 * 2.0 + recency + if s.is_error { 1.0 } else { 0.0 }, overlap)
        })
        .collect();
    let mut cited: BTreeSet<usize> = scored.iter().filter(|s| s.2 > 0).map(|s| s.0).collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    cited.extend(scored.iter().take(spans.len().div_ceil(2).max(1)).map(|s| s.0));
    cited.into_iter().map(|i| spans[i].id.clone()).collect()
}

pub fn compress(req: &Request) -> Report {
    let opts = &req.options;
    let tokens: Vec<u64> = req.spans.iter().map(|s| s.tokens.unwrap_or_else(|| estimate_tokens(&s.text))).collect();
    let total: u64 = tokens.iter().sum();

    if total <= opts.memory_budget_tokens {
        let decisions: Vec<Decision> = req
            .spans
            .iter()
            .enumerate()
            .map(|(i, s)| Decision {
                id: s.id.clone(),
                kind: s.kind.clone(),
                index: i,
                tokens: tokens[i],
                score: 1.0,
                kept: true,
                protected: true,
                reasons: vec!["under memory budget".into()],
            })
            .collect();
        return Report {
            triggered: false,
            total_tokens: total,
            kept_tokens: total,
            kept_count: decisions.len(),
            dropped_count: 0,
            kept: req.spans.iter().map(|s| s.id.clone()).collect(),
            decisions,
        };
    }

    // Citation frequency over the rollouts.
    let rollouts: Vec<Vec<String>> = match &req.cited {
        Some(c) if !c.is_empty() => c.clone(),
        // The heuristic is deterministic, so one rollout says it all.
        _ => vec![heuristic_cited(&req.spans, &req.task)],
    };
    let mut counts: BTreeMap<&str, u32> = BTreeMap::new();
    for rollout in &rollouts {
        for id in rollout.iter().collect::<BTreeSet<_>>() {
            *counts.entry(id.as_str()).or_default() += 1;
        }
    }
    let n = rollouts.len() as f64;
    let rescued: BTreeSet<&str> = req.rescued.iter().map(String::as_str).collect();
    let recent_start = req.spans.len().saturating_sub(opts.keep_recent);

    // The latest real instruction from the user is never dropped.
    let last_user = req.spans.iter().rposition(|s| s.kind == "user" || s.kind == "user_goal");
    let mut levels = Vec::with_capacity(req.spans.len());
    let mut decisions: Vec<Decision> = req
        .spans
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let score = f64::from(counts.get(s.id.as_str()).copied().unwrap_or(0)) / n;
            let mut reasons = Vec::new();
            let mut level = Level::None;
            let mut raise = |l: Level, why: &str| {
                level = level.max(l);
                reasons.push(why.to_string());
            };
            if s.is_error {
                raise(Level::Soft, "defensive: error/failure");
            }
            match s.kind.as_str() {
                "user_goal" => raise(Level::Hard, "defensive: task goal"),
                "user" if Some(i) == last_user => raise(Level::Hard, "defensive: latest user instruction"),
                "user" => raise(Level::Soft, "defensive: user instruction"),
                "loop" => raise(Level::Loop, "defensive: reviewer loop message"),
                "system" => raise(Level::Hard, "defensive: system"),
                _ => {}
            }
            if i >= recent_start {
                raise(Level::Hard, "defensive: recent state");
            }
            if rescued.contains(s.id.as_str()) {
                raise(Level::Soft, "defensive: draft-model rescue");
            }
            let protected = level != Level::None;
            let cited = score >= opts.tau;
            reasons.push(format!("utility {score:.2} {} tau {}", if cited { ">=" } else { "<" }, opts.tau));
            levels.push(level);
            Decision { id: s.id.clone(), kind: s.kind.clone(), index: i, tokens: tokens[i], score, kept: protected || cited, protected, reasons }
        })
        .collect();

    // Over the hard cap, spans are dropped in rounds until it fits: first
    // what nothing protects, then older reviewer-loop messages, then older
    // instructions, errors and rescues. Within a round the lowest utility
    // goes first, oldest first on a tie. The goal, the latest instruction,
    // system parts and the recent spans always stay.
    if let Some(cap) = opts.hard_cap_tokens {
        let mut kept_tokens: u64 = decisions.iter().filter(|d| d.kept).map(|d| d.tokens).sum();
        for (round, why) in [(Level::None, "dropped: over hard cap"), (Level::Loop, "dropped: over hard cap, older loop message"), (Level::Soft, "dropped: over hard cap, though defensive")] {
            let mut droppable: Vec<usize> = decisions.iter().filter(|d| d.kept && levels[d.index] == round).map(|d| d.index).collect();
            droppable.sort_by(|&a, &b| decisions[a].score.partial_cmp(&decisions[b].score).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(&b)));
            for i in droppable {
                if kept_tokens <= cap {
                    break;
                }
                decisions[i].kept = false;
                decisions[i].reasons.push(why.into());
                kept_tokens -= decisions[i].tokens;
            }
        }
    }

    let kept: Vec<String> = decisions.iter().filter(|d| d.kept).map(|d| d.id.clone()).collect();
    Report {
        triggered: true,
        total_tokens: total,
        kept_tokens: decisions.iter().filter(|d| d.kept).map(|d| d.tokens).sum(),
        kept_count: kept.len(),
        dropped_count: decisions.len() - kept.len(),
        kept,
        decisions,
    }
}
