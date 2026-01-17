# learning-tracker

An MCP server that tracks topics for spaced repetition learning using the FSRS v4 algorithm.

## Installation

```bash
npm install
```

Add to your Claude MCP config:

```json
{
  "mcpServers": {
    "learning-tracker": {
      "command": "node",
      "args": ["/path/to/learning-tracker/index.js"]
    }
  }
}
```

Add to your system prompt:
> The learning-tracker tool logs concepts the user asked about so they can review it later. Please use the learning-tracker tool to track a concept whenever the user asks for definition or clarification of a technical concept or best practices in any domain (eg.  daily life hacks, machine learning, software engineering, computer science, coding, physics, math, statistics). During review, only mention the concept title at first, and the user will attempt to explain it.

## Tools

| Tool | Description |
|------|-------------|
| `append_topic` | Log topics with optional summary and tags |
| `get_topics` | Retrieve all logged topics |
| `clear_topics` | Clear all topics (creates backup) |
| `review_next_topic` | Get the next topic to review |
| `log_review_outcome` | Record review result (1=Again, 2=Hard, 3=Good, 4=Easy) |

## Data

- Topics: `~/Claude/learned_topics.jsonl`
- Config: `~/Claude/fsrs_config.json`
- Backups: `~/.topics_backup/`
