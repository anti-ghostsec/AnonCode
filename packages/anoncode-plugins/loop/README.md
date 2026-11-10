# Reviewer loop

A per-chat reviewer for the agent. Arm it with what the reviewer should check; after every turn
the reviewer reads that turn's work and replies in the chat with the next step, or says the loop
is done or blocked.

Everything the loop tells the agent is an ordinary message in the chat, readable exactly as the
model received it. Nothing is added to the model's context out of sight.

The reviewer runs in its own short-lived child chat, so it never sees old turns and reports its
own cost. It can use a different model.

## Commands

```
/loop <review instructions>       arm a loop for the current chat
/loop <mission> :: <review>       arm with an explicit mission
/loop start <review>              arm even when the text begins with a control word
/loop review <instructions>       change the reviewer's instructions
/loop task <mission>              change the mission (task default clears it)
/loop model <provider/model>      use another model for the reviewer
/loop model default               use the agent's model for the reviewer
/loop cost <usd|default>          combined chat + reviewer cost limit
/loop time <minutes|default>      wall-clock limit
/loop note <text>                 queue a note while it runs
/loop                             show status
/loop pause | resume | clear
```

In the AnonCode window the same controls are behind the **Loop…** button.

## What the reviewer is given

1. Its instructions.
2. The mission, captured when the loop was armed.
3. The agent's last message of the turn.
4. That turn's tool calls and their output.
5. New messages from you in that turn.

## Limits

- 50 rounds at most; three rounds without progress pause the loop.
- Optional cost and time limits pause it too. Resume starts a fresh time budget.
- A restart, an interruption, a failed turn or an unreadable reviewer reply pauses it.
