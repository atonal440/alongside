# Alongside Feature Improvements

## Data Model
- Recurring tasks should inherit kickoff notes and other data, or at least be built from a template.
- There ought to be a way to have a recurring sequence of blockers.
- We should seek alternatives to completion-driven recurrence logic, though it is simple and elegant.
- Notes and kickoff_note should be treated somewhat differently. Notes should be rich text, ideally. 

## MCP Tools

- is there a way to make the start_session prompt injector more automatic? Idea would be that the model would call it the first time it uses any of the other tools in a session. 

## MCP App UI

## Web App UI

- This needs a full rework. Use this to set a consistent and distinctive UI design between the web and mcp components. 
- App UI should allow focus on one or two tasks at a time, avoid big lists. Kanban board style?
- An important use will be to add context and info to tasks directly.