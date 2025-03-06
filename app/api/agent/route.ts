import { NextResponse } from 'next/server';
import { openai } from "@ai-sdk/openai";
import { CoreMessage, generateObject, UserContent } from "ai";
import { z } from "zod";
import { ObserveResult, Stagehand } from "@browserbasehq/stagehand";
import { google } from "@ai-sdk/google";
import { searchForTaskContext } from './search';
import { createTaskPlan } from './planner';
import { executeSubtask, BrowserStep } from './worker';
import * as TaskManager from './task-manager';

const LLMSearch = google("gemini-1.5-flash", {
  useSearchGrounding: true,
});

const LLMClient = openai("gpt-4o");

type Step = {
  text: string;
  reasoning: string;
  tool: "GOTO" | "ACT" | "EXTRACT" | "OBSERVE" | "CLOSE" | "WAIT" | "NAVBACK";
  instruction: string;
};

/**
 * Executes browser automation commands via Stagehand
 */
async function runStagehand({
  sessionID,
  method,
  instruction,
}: {
  sessionID: string;
  method: "GOTO" | "ACT" | "EXTRACT" | "CLOSE" | "SCREENSHOT" | "OBSERVE" | "WAIT" | "NAVBACK";
  instruction?: string;
}) {
  const stagehand = new Stagehand({
    browserbaseSessionID: sessionID,
    env: "BROWSERBASE",
    logger: () => {},
  });
  await stagehand.init();

  const page = stagehand.page;

  try {
    switch (method) {
      case "GOTO":
        await page.goto(instruction!, {
          waitUntil: "commit",
          timeout: 60000,
        });
        break;

      case "ACT":
        await page.act(instruction!);
        break;

      case "EXTRACT": {
        const { extraction } = await page.extract(instruction!);
        return extraction;
      }

      case "OBSERVE":
        return await page.observe({
          instruction,
          useAccessibilityTree: true,
        });

      case "CLOSE":
        await stagehand.close();
        break;

      case "SCREENSHOT": {
        const cdpSession = await page.context().newCDPSession(page);
        const { data } = await cdpSession.send("Page.captureScreenshot");
        return data;
      }

      case "WAIT":
        await new Promise((resolve) =>
          setTimeout(resolve, Number(instruction))
        );
        break;

      case "NAVBACK":
        await page.goBack();
        break;
    }
  } catch (error) {
    await stagehand.close();
    throw error;
  }
}

/**
 * Generates the next action to take based on the goal, current page, and previous steps
 */
async function sendPrompt({
  goal,
  sessionID,
  previousSteps = [],
  previousExtraction,
}: {
  goal: string;
  sessionID: string;
  previousSteps?: Step[];
  previousExtraction?: string | ObserveResult[];
}) {
  let currentUrl = "";

  try {
    const stagehand = new Stagehand({
      browserbaseSessionID: sessionID,
      env: "BROWSERBASE"
    });
    await stagehand.init();
    currentUrl = await stagehand.page.url();
    await stagehand.close();
  } catch (error) {
    console.error('Error getting page info:', error);
  }

  const content: UserContent = [
    {
      type: "text",
      text: `Consider the following screenshot of a web page${currentUrl ? ` (URL: ${currentUrl})` : ''}, with the goal being "${goal}".
${previousSteps.length > 0
    ? `Previous steps taken:
${previousSteps
  .map(
    (step, index) => `
Step ${index + 1}:
- Action: ${step.text}
- Reasoning: ${step.reasoning}
- Tool Used: ${step.tool}
- Instruction: ${step.instruction}
`
  )
  .join("\n")}`
    : ""
}
Determine the immediate next step to take to achieve the goal. 

Important guidelines:
1. Break down complex actions into individual atomic steps
2. For ACT commands, use only one action at a time, such as:
   - Single click on a specific element
   - Type into a single input field
   - Select a single option
3. Avoid combining multiple actions in one instruction
4. If multiple actions are needed, they should be separate steps

If the goal has been achieved, return "close".`,
    },
  ];

  // Add screenshot if navigated to a page previously
  if (previousSteps.length > 0 && previousSteps.some((step) => step.tool === "GOTO")) {
    content.push({
      type: "image",
      image: (await runStagehand({
        sessionID,
        method: "SCREENSHOT",
      })) as string,
    });
  }

  if (previousExtraction) {
    content.push({
      type: "text",
      text: `The result of the previous ${
        Array.isArray(previousExtraction) ? "observation" : "extraction"
      } is: ${previousExtraction}.`,
    });
  }

  const message: CoreMessage = {
    role: "user",
    content,
  };

  const result = await generateObject({
    model: LLMClient,
    schema: z.object({
      text: z.string(),
      reasoning: z.string(),
      tool: z.enum([
        "GOTO",
        "ACT",
        "EXTRACT",
        "OBSERVE",
        "CLOSE",
        "WAIT",
        "NAVBACK",
      ]),
      instruction: z.string(),
    }),
    messages: [message],
  });

  return {
    result: result.object,
    previousSteps: [...previousSteps, result.object],
  };
}

/**
 * Determines the best starting URL for a given goal
 */
async function selectStartingUrl(goal: string) {
  const message: CoreMessage = {
    role: "user",
    content: [{
      type: "text",
      text: `Given the goal: "${goal}", determine the best URL to start from.
Choose from:
1. A relevant search engine (Google, Bing, etc.)
2. A direct URL if you're confident about the target website
3. Any other appropriate starting point

Return a URL that would be most effective for achieving this goal.`
    }]
  };

  const result = await generateObject({
    model: LLMClient,
    schema: z.object({
      url: z.string().url(),
      reasoning: z.string()
    }),
    messages: [message]
  });

  return result.object;
}

/**
 * Validates request parameters for different action types
 */
function validateRequestParams(action: string, params: Record<string, any>) {
  const requiredParams: Record<string, string[]> = {
    'START': ['goal', 'sessionId'],
    'GET_NEXT_STEP': ['goal', 'sessionId'],
    'EXECUTE_STEP': ['sessionId', 'step'],
    'PLAN_TASK': ['goal'],
    'GET_WORKER_TASK': ['taskId', 'workerId'],
    'EXECUTE_WORKER_TASK': ['taskId', 'workerId', 'subtaskId', 'sessionId', 'overallGoal', 'subtaskGoal', 'subtaskDescription'],
    'GET_TASK_STATUS': ['taskId']
  };

  const missingParams = (requiredParams[action] || []).filter(param => !params[param]);
  
  if (missingParams.length > 0) {
    return {
      valid: false,
      error: `Missing required parameters: ${missingParams.join(', ')}`
    };
  }
  
  return { valid: true };
}

export async function GET() {
  return NextResponse.json({ message: 'Agent API endpoint ready' });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { 
      action,
      goal, 
      sessionId, 
      step, 
      previousSteps, 
      previousExtraction,
      taskId,
      workerId,
      subtaskId,
      overallGoal,
      subtaskGoal,
      subtaskDescription
    } = body;

    if (!action) {
      return NextResponse.json(
        { error: 'Missing action in request body', success: false },
        { status: 400 }
      );
    }

    // Validate request parameters
    const validation = validateRequestParams(action, body);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error, success: false },
        { status: 400 }
      );
    }

    // Handle different action types
    switch (action) {
      // Legacy action handlers - keep these for backward compatibility
      case 'START': {
        // Handle first step with URL selection
        const { url, reasoning } = await selectStartingUrl(goal);
        const firstStep = {
          text: `Navigating to ${url}`,
          reasoning,
          tool: "GOTO" as const,
          instruction: url
        };
        
        await runStagehand({
          sessionID: sessionId,
          method: "GOTO",
          instruction: url
        });

        return NextResponse.json({ 
          success: true,
          result: firstStep,
          done: false,
        });
      }

      case 'GET_NEXT_STEP': {
        try {
          // Get the next step from the agent
          const { result, previousSteps: newPreviousSteps } = await sendPrompt({
            goal,
            sessionID: sessionId,
            previousSteps: previousSteps || [],
            previousExtraction
          });

          // Check if this is the final step
          const isDone = result.tool === "CLOSE";

          return NextResponse.json({
            success: true,
            result,
            done: isDone,
          });
        } catch (error) {
          console.error("[ERROR] Get next step failed:", error);
          return NextResponse.json(
            { error: `Get next step failed: ${error instanceof Error ? error.message : "Unknown error"}`, success: false },
            { status: 500 }
          );
        }
      }

      case 'EXECUTE_STEP': {
        try {
          // Execute the step using stagehand
          const result = await runStagehand({
            sessionID: sessionId,
            method: step.tool,
            instruction: step.instruction,
          });

          // Check if this is the final step
          const isDone = step.tool === "CLOSE";

          return NextResponse.json({
            success: true,
            result,
            done: isDone,
          });
        } catch (error) {
          console.error("[ERROR] Execute step failed:", error);
          return NextResponse.json(
            { error: `Execute step failed: ${error instanceof Error ? error.message : "Unknown error"}`, success: false },
            { status: 500 }
          );
        }
      }

      // New action handlers for the planning-workers architecture
      case 'PLAN_TASK': {
        try {
          // Search for relevant context
          const { searchContext } = await searchForTaskContext(goal);
          console.log("[VERBOSE] Search context:", searchContext);

          // Create a task plan using the planner
          const plan = await createTaskPlan({ task: goal, searchContext });
          console.log("[VERBOSE] Created plan:", plan);

          // Create a task in the task manager
          const task = TaskManager.createTask(goal, plan, sessionId);
          console.log("[VERBOSE] Created task:", task.id);

          return NextResponse.json({
            success: true,
            taskId: task.id,
            plan: plan,
          });
        } catch (error) {
          console.error("[ERROR] Planning failed:", error);
          return NextResponse.json(
            { error: `Planning failed: ${error instanceof Error ? error.message : "Unknown error"}`, success: false },
            { status: 500 }
          );
        }
      }

      case 'GET_WORKER_TASK': {
        try {
          // Get the next available subtask for this task
          const subtask = TaskManager.getNextAvailableSubtask(taskId);
          console.log("[VERBOSE] Next available subtask:", subtask?.id || "none");

          if (!subtask) {
            return NextResponse.json({
              success: true,
              hasTask: false,
            });
          }

          const task = TaskManager.getTask(taskId);
          if (!task) {
            return NextResponse.json(
              { error: `Task not found: ${taskId}`, success: false },
              { status: 404 }
            );
          }

          // Return the subtask details
          return NextResponse.json({
            success: true,
            hasTask: true,
            subtaskId: subtask.id,
            overallGoal: task.goal,
            subtaskGoal: subtask.goal,
            subtaskDescription: subtask.description,
          });
        } catch (error) {
          console.error("[ERROR] Get worker task failed:", error);
          return NextResponse.json(
            { error: `Get worker task failed: ${error instanceof Error ? error.message : "Unknown error"}`, success: false },
            { status: 500 }
          );
        }
      }

      case 'EXECUTE_WORKER_TASK': {
        try {
          // Execute the subtask
          console.log(`[VERBOSE] Executing subtask: ${subtaskId}`);
          const result = await executeSubtask({
            subtaskId,
            sessionId,
            overallGoal,
            subtaskGoal,
            subtaskDescription,
          });
          console.log(`[VERBOSE] Subtask execution complete (${result.status}):`, result);

          // Update the subtask status in the task manager
          TaskManager.updateSubtaskStatus(
            taskId,
            subtaskId,
            result.status,
            result
          );

          return NextResponse.json({
            success: true,
            result,
          });
        } catch (error) {
          console.error("[ERROR] Execute worker task failed:", error);
          
          // Mark the subtask as failed in the task manager
          try {
            TaskManager.updateSubtaskStatus(
              taskId, 
              subtaskId, 
              'FAILED', 
              { 
                status: 'FAILED', 
                steps: [], 
                error: error instanceof Error ? error.message : "Unknown error",
                retryCount: 0
              }
            );
          } catch (updateError) {
            console.error("[ERROR] Failed to update subtask status:", updateError);
          }

          return NextResponse.json(
            { error: `Execute worker task failed: ${error instanceof Error ? error.message : "Unknown error"}`, success: false },
            { status: 500 }
          );
        }
      }

      case 'GET_TASK_STATUS': {
        try {
          const task = TaskManager.getTask(taskId);
          if (!task) {
            return NextResponse.json(
              { error: `Task not found: ${taskId}`, success: false },
              { status: 404 }
            );
          }

          const progress = TaskManager.getTaskProgressById(taskId);
          if (!progress) {
            return NextResponse.json(
              { error: `Could not get progress for task: ${taskId}`, success: false },
              { status: 500 }
            );
          }

          return NextResponse.json({
            success: true,
            status: task.status,
            progress,
          });
        } catch (error) {
          console.error("[ERROR] Get task status failed:", error);
          return NextResponse.json(
            { error: `Get task status failed: ${error instanceof Error ? error.message : "Unknown error"}`, success: false },
            { status: 500 }
          );
        }
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}`, success: false },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('Error in agent endpoint:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to process request' },
      { status: 500 }
    );
  }
} 