/**
 * FSRS (Free Spaced Repetition Scheduler) Algorithm Implementation
 * Based on FSRS v4 specification
 */

import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_PATH = path.join(os.homedir(), "Claude", "fsrs_config.json");

const DEFAULT_CONFIG = {
  version: "4",
  weights: [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26],
  target_retrievability: 0.9,
  maximum_interval_days: 365
};

/**
 * Load FSRS configuration, creating default if it doesn't exist
 */
export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return DEFAULT_CONFIG;
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

/**
 * Calculate retrievability at time t days since last review
 * R(t) = (1 + t/(9*S))^(-1)
 */
export function retrievability(stability, elapsedDays) {
  if (stability === null || stability <= 0) return 0;
  return Math.pow(1 + elapsedDays / (9 * stability), -1);
}

/**
 * Calculate next interval for target retrievability
 * I = 9 * S * (1/R_target - 1)
 */
export function nextInterval(stability, targetRetrievability) {
  if (stability === null || stability <= 0) return 1;
  return 9 * stability * (1 / targetRetrievability - 1);
}

/**
 * Clamp a value between min and max
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Calculate initial stability based on first grade
 * S_0 = w[grade-1]
 */
export function initialStability(grade, weights) {
  return weights[grade - 1];
}

/**
 * Calculate initial difficulty based on first grade
 * D_0 = w4 - w5*(grade-3), clamped [1,10]
 */
export function initialDifficulty(grade, weights) {
  const d0 = weights[4] - weights[5] * (grade - 3);
  return clamp(d0, 1, 10);
}

/**
 * Update difficulty after review
 * D' = D - w6*(grade-3), with mean reversion using w7
 */
export function updateDifficulty(currentDifficulty, grade, weights) {
  const w6 = weights[6];
  const w7 = weights[7];

  // Mean reversion toward initial difficulty
  const meanDifficulty = weights[4];
  const delta = -w6 * (grade - 3);
  const newD = currentDifficulty + delta;

  // Apply mean reversion
  const revertedD = newD + w7 * (meanDifficulty - newD);
  return clamp(revertedD, 1, 10);
}

/**
 * Update stability after successful review (grade >= 2)
 * Complex formula with w8-w10
 */
export function updateStabilitySuccess(stability, difficulty, retrievability, grade, weights) {
  const w8 = weights[8];
  const w9 = weights[9];
  const w10 = weights[10];

  // S' = S * (1 + exp(w8) * (11 - D) * S^(-w9) * (exp(w10 * (1 - R)) - 1) * hardPenalty * easyBonus)
  const hardPenalty = grade === 2 ? weights[15] || 1.0 : 1.0;
  const easyBonus = grade === 4 ? weights[16] || 1.0 : 1.0;

  // Simplified formula without optional weights
  const factor = Math.exp(w8) *
    (11 - difficulty) *
    Math.pow(stability, -w9) *
    (Math.exp(w10 * (1 - retrievability)) - 1);

  return stability * (1 + factor);
}

/**
 * Update stability after failure (grade = 1)
 * S' = w11 * D^(-w12) * ((S+1)^w13 - 1) * exp(w14 * (1 - R))
 */
export function updateStabilityFailure(stability, difficulty, retrievability, weights) {
  const w11 = weights[11];
  const w12 = weights[12];
  const w13 = weights[13];
  const w14 = weights[14];

  const newStability = w11 *
    Math.pow(difficulty, -w12) *
    (Math.pow(stability + 1, w13) - 1) *
    Math.exp(w14 * (1 - retrievability));

  // Ensure stability doesn't exceed previous value after failure
  return Math.min(newStability, stability);
}

/**
 * Create default FSRS state for new topics
 */
export function createDefaultFsrsState() {
  return {
    state: "new",
    stability: null,
    difficulty: null,
    due: null,
    last_reviewed: null,
    review_count: 0,
    lapses: 0
  };
}

/**
 * Process a review and return updated FSRS state
 * @param {Object} currentFsrs - Current FSRS state
 * @param {number} grade - Review grade (1-4)
 * @param {Object} config - FSRS configuration
 * @returns {Object} Updated FSRS state
 */
export function processReview(currentFsrs, grade, config = null) {
  if (!config) {
    config = loadConfig();
  }

  const weights = config.weights;
  const targetR = config.target_retrievability;
  const maxInterval = config.maximum_interval_days;
  const now = new Date();

  let newState = { ...currentFsrs };
  newState.last_reviewed = now.toISOString();
  newState.review_count = (currentFsrs.review_count || 0) + 1;

  // Calculate elapsed days since last review
  let elapsedDays = 0;
  if (currentFsrs.last_reviewed) {
    const lastReview = new Date(currentFsrs.last_reviewed);
    elapsedDays = (now - lastReview) / (1000 * 60 * 60 * 24);
  }

  // Get current retrievability
  const currentR = currentFsrs.stability
    ? retrievability(currentFsrs.stability, elapsedDays)
    : 0;

  if (currentFsrs.state === "new") {
    // First review - initialize stability and difficulty
    newState.stability = initialStability(grade, weights);
    newState.difficulty = initialDifficulty(grade, weights);

    if (grade === 1) {
      // Failed first review - goes to learning
      newState.state = "learning";
      newState.lapses = 1;
    } else {
      // Passed first review - goes to review
      newState.state = "review";
    }
  } else {
    // Subsequent review
    newState.difficulty = updateDifficulty(currentFsrs.difficulty, grade, weights);

    if (grade === 1) {
      // Failed - update stability with failure formula
      newState.stability = updateStabilityFailure(
        currentFsrs.stability,
        currentFsrs.difficulty,
        currentR,
        weights
      );
      newState.lapses = (currentFsrs.lapses || 0) + 1;
      newState.state = "relearning";
    } else {
      // Passed - update stability with success formula
      newState.stability = updateStabilitySuccess(
        currentFsrs.stability,
        currentFsrs.difficulty,
        currentR,
        grade,
        weights
      );
      newState.state = "review";
    }
  }

  // Calculate next due date
  let interval = nextInterval(newState.stability, targetR);
  interval = Math.min(interval, maxInterval);
  interval = Math.max(interval, 1); // Minimum 1 day

  const dueDate = new Date(now.getTime() + interval * 24 * 60 * 60 * 1000);
  newState.due = dueDate.toISOString();

  return newState;
}

/**
 * Calculate priority score for topic selection
 * Higher score = more urgent review
 */
export function calculatePriority(topic) {
  const fsrs = topic.fsrs;
  if (!fsrs) return { priority: 0, isOverdue: false, retrievability: 1 };

  const now = new Date();

  // New topics get moderate priority
  if (fsrs.state === "new") {
    return { priority: 50, isOverdue: false, retrievability: null };
  }

  // If no due date, treat as new
  if (!fsrs.due) {
    return { priority: 50, isOverdue: false, retrievability: null };
  }

  const dueDate = new Date(fsrs.due);
  const daysUntilDue = (dueDate - now) / (1000 * 60 * 60 * 24);

  // Calculate current retrievability
  let elapsedDays = 0;
  if (fsrs.last_reviewed) {
    const lastReview = new Date(fsrs.last_reviewed);
    elapsedDays = (now - lastReview) / (1000 * 60 * 60 * 24);
  }
  const currentR = fsrs.stability ? retrievability(fsrs.stability, elapsedDays) : 0;

  if (daysUntilDue < 0) {
    // Overdue - priority based on how much retrievability has decayed
    // Lower retrievability = higher priority (multiply by 100 for scale)
    return {
      priority: 100 + (1 - currentR) * 100,
      isOverdue: true,
      retrievability: currentR,
      daysOverdue: -daysUntilDue
    };
  } else {
    // Not yet due - lower priority
    return {
      priority: Math.max(0, 40 - daysUntilDue * 10),
      isOverdue: false,
      retrievability: currentR,
      daysUntilDue: daysUntilDue
    };
  }
}
