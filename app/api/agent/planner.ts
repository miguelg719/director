import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { PLANNER_PROMPT } from "./prompts";

// Initialize the planning LLM
const PlannerLLM = openai("gpt-4o");

// Define the subtask interface
export interface Subtask {
  id: string;
  description: string;
  goal: string;
  dependencies?: string[]; // IDs of subtasks that must be completed before this one
  status: "PENDING" | "IN_PROGRESS" | "DONE" | "FAILED";
}

// Define the plan interface
export interface TaskPlan {
  summary: string;
  subtasks: Subtask[];
}

/**
 * Planning agent that breaks down a task into subtasks
 * 
 * @param task The user's task description
 * @param searchContext The context information from the search agent
 * @returns A detailed plan with subtasks
 */
export async function createTaskPlan({
  task,
  searchContext,
}: {
  task: string;
  searchContext: string;
}): Promise<TaskPlan> {
  try {
    // Generate a plan using the LLM
    const planResult = await generateObject({
      model: PlannerLLM,
      schema: z.object({
        summary: z.string().describe("A summary of the overall task plan"),
        subtasks: z.array(
          z.object({
            description: z.string().describe("A clear description of what this subtask should accomplish"),
            goal: z.string().describe("The specific goal this subtask aims to achieve"),
            dependencies: z.array(z.number()).optional()
              .describe("Array of subtask indices (0-based) that must be completed before this subtask can begin")
          })
        ).min(1).describe("An array of subtasks to accomplish the overall goal")
      }),
      messages: [
        {
          role: "system",
          content: PLANNER_PROMPT
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `I need a plan for accomplishing this task: "${task}"\n\nHere's some context from my search that may help with planning:\n\n${searchContext}`
            }
          ]
        }
      ]
    });
    
    // Transform the result into our TaskPlan format with generated IDs
    const subtasks = planResult.object.subtasks.map((subtask, index) => ({
      id: `subtask-${index + 1}`,
      description: subtask.description,
      goal: subtask.goal,
      dependencies: subtask.dependencies?.map(depIndex => `subtask-${depIndex + 1}`),
      status: "PENDING" as const
    }));
    
    return {
      summary: planResult.object.summary,
      subtasks
    };
  } catch (error: unknown) {
    console.error("Error in planning agent:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Planning agent failed: ${errorMessage}`);
  }
} 