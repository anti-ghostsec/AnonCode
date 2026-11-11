//! Some models (DeepSeek through some providers) sometimes write a tool
//! call as plain text in their own markup, such as
//! `<｜DSML｜ calls> <｜DSML｜ invoke name="write"> ...`, instead of making
//! the call. The call never runs and the markup is noise, so the chat view
//! leaves it out. The `tidy` plugin does the same for what the model is
//! sent back.

const OPEN: &[&str] = &["<｜DSML｜", "<｜tool▁calls▁begin｜", "<｜tool▁call▁begin｜"];
const CLOSE: &[&str] = &["</｜DSML｜", "<｜tool▁calls▁end｜>"];
const STRAY: &[&str] = &["<｜end▁of▁sentence｜>", "<｜tool▁sep｜>", "<｜tool▁call▁end｜>", "<｜tool▁output▁begin｜>", "<｜tool▁output▁end｜>", "<｜tool▁outputs▁begin｜>", "<｜tool▁outputs▁end｜>"];

/// The text without tool calls written out as markup. Borrowed when there
/// is none, which is nearly always.
pub fn tidy(text: &str) -> std::borrow::Cow<'_, str> {
    if !text.contains("<｜") {
        return text.into();
    }
    let mut out = text.to_string();
    while let Some(start) = OPEN.iter().filter_map(|m| out.find(m)).min() {
        let rest = &out[start..];
        // The block ends at its last closing tag; one cut off runs to the end.
        let end = CLOSE
            .iter()
            .filter_map(|m| rest.rfind(m).map(|i| i + rest[i..].find('>').map_or(rest.len() - i, |j| j + 1)))
            .max()
            .map_or(out.len(), |e| start + e);
        out = format!("{} {}", out[..start].trim_end(), out[end..].trim_start()).trim().to_string();
    }
    for m in STRAY {
        out = out.replace(m, "");
    }
    out.into()
}
