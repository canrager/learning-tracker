#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import {
  createDefaultFsrsState,
  processReview,
  calculatePriority,
  loadConfig as loadFsrsConfig
} from "./fsrs.js";

const TOPICS_DIR = path.join(os.homedir(), "Claude");
const TOPICS_FILE = path.join(TOPICS_DIR, "learned_topics.jsonl");
const BACKUP_DIR = path.join(os.homedir(), ".topics_backup");
const MAX_BACKUPS = 10;

// Ensure directories exist
if (!fs.existsSync(TOPICS_DIR)) {
  fs.mkdirSync(TOPICS_DIR, { recursive: true });
}
if (!fs.existsSync(TOPICS_FILE)) {
  fs.writeFileSync(TOPICS_FILE, "");
}
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * Create a backup of the topics file
 */
function createBackup() {
  if (!fs.existsSync(TOPICS_FILE)) return;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(BACKUP_DIR, `topics_${timestamp}.jsonl`);
  fs.copyFileSync(TOPICS_FILE, backupPath);

  // Cleanup old backups, keeping only the most recent MAX_BACKUPS
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith("topics_") && f.endsWith(".jsonl"))
    .sort()
    .reverse();

  for (let i = MAX_BACKUPS; i < backups.length; i++) {
    fs.unlinkSync(path.join(BACKUP_DIR, backups[i]));
  }
}

/**
 * Atomic write: write to temp file, then rename
 */
function atomicWriteTopics(topics) {
  const tmpPath = TOPICS_FILE + ".tmp";
  const content = topics.map(t => JSON.stringify(t)).join("\n") + (topics.length > 0 ? "\n" : "");
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, TOPICS_FILE);
}

/**
 * Load topics with lazy migration for FSRS fields
 */
function loadTopics() {
  const content = fs.readFileSync(TOPICS_FILE, "utf-8").trim();
  if (!content) return [];

  let topics = content.split("\n").map(line => JSON.parse(line));
  let needsMigration = false;

  topics = topics.map(topic => {
    let modified = false;

    // Add id if missing
    if (!topic.id) {
      topic.id = crypto.randomUUID();
      modified = true;
    }

    // Add fsrs state if missing
    if (!topic.fsrs) {
      topic.fsrs = createDefaultFsrsState();
      modified = true;
    }

    if (modified) needsMigration = true;
    return topic;
  });

  // Persist migration if needed
  if (needsMigration) {
    createBackup();
    atomicWriteTopics(topics);
  }

  return topics;
}

/**
 * Save a single updated topic back to the file
 */
function updateTopic(topicId, updater) {
  const topics = loadTopics();
  const index = topics.findIndex(t => t.id === topicId);

  if (index === -1) {
    return { success: false, error: "Topic not found" };
  }

  createBackup();
  topics[index] = updater(topics[index]);
  atomicWriteTopics(topics);

  return { success: true, topic: topics[index] };
}

const server = new Server(
  { name: "learning-tracker", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "append_topic",
      description: "Log technical topics the user asked clarification for. Can log multiple topics in a single call by passing an array.",
      inputSchema: {
        type: "object",
        properties: {
          topics: {
            type: "array",
            items: {
              type: "object",
              properties: {
                topic: { type: "string", description: "The topic name" },
                summary: { type: "string", description: "One sentence definition of the topic, and one sentence about the context in which it was asked for (context can be None if the user asked right at the start of the conversation and did not give clarification)." },
                tags: {
                  type: "array",
                  items: { type: "string" },
                  description: "Optional categorization tags"
                }
              },
              required: ["topic"]
            },
            description: "Array of one or more topics to log simultaneously"
          }
        },
        required: ["topics"]
      }
    },
    {
      name: "get_topics",
      description: "Retrieve all logged topics for review",
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Optional: filter by tag" },
          limit: { type: "number", description: "Optional: limit results" }
        }
      }
    },
    {
      name: "clear_topics",
      description: "Clear all logged topics",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "review_next_topic",
      description: "Returns the most urgent topic for review based on FSRS scheduling. Priority: overdue topics (by retrievability decay) > new topics > scheduled topics.",
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Optional: filter by tag" },
          include_stats: { type: "boolean", description: "Optional: include current retrievability and days overdue in response" }
        }
      }
    },
    {
      name: "log_review_outcome",
      description: "Records review result and updates FSRS state for a topic. Creates backup before modification.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The topic UUID" },
          grade: {
            type: "number",
            enum: [1, 2, 3, 4],
            description: "Review grade: 1=Again (forgot), 2=Hard, 3=Good, 4=Easy"
          }
        },
        required: ["id", "grade"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "append_topic") {
    const entries = args.topics.map(t => ({
      id: crypto.randomUUID(),
      topic: t.topic,
      summary: t.summary || null,
      tags: t.tags || [],
      timestamp: new Date().toISOString(),
      fsrs: createDefaultFsrsState()
    }));

    const lines = entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
    fs.appendFileSync(TOPICS_FILE, lines);

    const topicNames = entries.map(e => e.topic).join(", ");
    return { content: [{ type: "text", text: `Logged ${entries.length} topic(s): ${topicNames}` }] };
  }

  if (name === "get_topics") {
    let topics = loadTopics();

    if (!topics.length) {
      return { content: [{ type: "text", text: "No topics logged yet." }] };
    }

    if (args.tag) {
      topics = topics.filter(t => t.tags?.includes(args.tag));
    }
    if (args.limit) {
      topics = topics.slice(-args.limit);
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify(topics, null, 2)
      }]
    };
  }

  if (name === "clear_topics") {
    createBackup();
    fs.writeFileSync(TOPICS_FILE, "");
    return { content: [{ type: "text", text: "All topics cleared. Backup created." }] };
  }

  if (name === "review_next_topic") {
    let topics = loadTopics();

    if (!topics.length) {
      return { content: [{ type: "text", text: "No topics available for review." }] };
    }

    // Filter by tag if specified
    if (args.tag) {
      topics = topics.filter(t => t.tags?.includes(args.tag));
      if (!topics.length) {
        return { content: [{ type: "text", text: `No topics with tag "${args.tag}" available for review.` }] };
      }
    }

    // Calculate priority for each topic
    const topicsWithPriority = topics.map(t => ({
      topic: t,
      ...calculatePriority(t)
    }));

    // Sort by priority (highest first)
    topicsWithPriority.sort((a, b) => b.priority - a.priority);

    const selected = topicsWithPriority[0];
    const topic = selected.topic;

    const response = {
      id: topic.id,
      topic: topic.topic,
      summary: topic.summary,
      tags: topic.tags,
      state: topic.fsrs?.state || "new"
    };

    if (args.include_stats) {
      response.stats = {
        retrievability: selected.retrievability,
        isOverdue: selected.isOverdue,
        daysOverdue: selected.daysOverdue || null,
        daysUntilDue: selected.daysUntilDue || null,
        priority: selected.priority
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify(response, null, 2)
      }]
    };
  }

  if (name === "log_review_outcome") {
    const { id, grade } = args;

    // Validate grade
    if (![1, 2, 3, 4].includes(grade)) {
      return {
        content: [{
          type: "text",
          text: `Error: Invalid grade ${grade}. Must be 1 (Again), 2 (Hard), 3 (Good), or 4 (Easy).`
        }]
      };
    }

    // Load FSRS config
    const config = loadFsrsConfig();

    // Update the topic
    const result = updateTopic(id, (topic) => {
      const newFsrs = processReview(topic.fsrs || createDefaultFsrsState(), grade, config);
      return { ...topic, fsrs: newFsrs };
    });

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: `Error: ${result.error}. Topic ID: ${id}`
        }]
      };
    }

    const topic = result.topic;
    const gradeNames = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };

    const response = {
      success: true,
      topic: topic.topic,
      grade: `${grade} (${gradeNames[grade]})`,
      new_state: {
        state: topic.fsrs.state,
        stability: Math.round(topic.fsrs.stability * 100) / 100,
        difficulty: Math.round(topic.fsrs.difficulty * 100) / 100,
        next_review: topic.fsrs.due,
        review_count: topic.fsrs.review_count,
        lapses: topic.fsrs.lapses
      }
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify(response, null, 2)
      }]
    };
  }

  return { content: [{ type: "text", text: "Unknown tool" }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
