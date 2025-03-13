import { openai } from "@ai-sdk/openai";
import { generateObject, CoreMessage, UserContent } from "ai";
import { z } from "zod";
import { ObserveResult, Stagehand } from "@browserbasehq/stagehand";
import { WORKER_PROMPT } from "./prompts";

// Initialize the worker LLM
const WorkerLLM = openai("gpt-4o");

// Define the step interface (similar to the existing Step type)
export interface BrowserStep {
  text: string;
  reasoning: string;
  tool: "GOTO" | "ACT" | "EXTRACT" | "OBSERVE" | "CLOSE" | "WAIT" | "NAVBACK" | "SCREENSHOT" | "DONE" | "FAIL";
  instruction: string;
  stepNumber?: number;
}

// Worker result interface
export interface WorkerResult {
  status: "DONE" | "FAILED";
  steps: BrowserStep[];
  extraction?: any;
  error?: string;
  retryCount: number;
}

// Run a stagehand command
async function runStagehand({
  sessionID,
  subtaskId,
  method,
  instruction,
}: {
  sessionID: string;
  subtaskId: string;
  method: BrowserStep["tool"];
  instruction?: string;
}) {
  // Special handling for the new DONE and FAIL tools
  if (method === "DONE") {
    console.log(`[WORKER:${subtaskId}] Task marked as DONE: ${instruction}`);
    return { status: "DONE", message: instruction };
  }
  
  if (method === "FAIL") {
    console.log(`[WORKER:${subtaskId}] Task marked as FAILED: ${instruction}`);
    return { status: "FAILED", message: instruction };
  }

  const stagehand = new Stagehand({
    browserbaseSessionID: sessionID,
    env: "BROWSERBASE",
    logger: () => {},
  });
  
  try {
    await stagehand.init();
    const page = stagehand.page;

    switch (method) {
      case "GOTO":
        console.log(`[WORKER:${subtaskId}] Navigating to: ${instruction}`);
        await page.goto(instruction!, {
          waitUntil: "commit",
          timeout: 60000,
        });
        break;

      case "ACT":
        console.log(`[WORKER:${subtaskId}] Performing action: ${instruction}`);
        await page.act({
            action: instruction!,
            slowDomBasedAct: false,
        }!);
        break;

      case "EXTRACT": {
        console.log(`[WORKER:${subtaskId}] Extracting: ${instruction}`);
        const { extraction } = await page.extract(instruction!);
        return extraction;
      }

      case "OBSERVE":
        console.log(`[WORKER:${subtaskId}] Observing with instruction: ${instruction || "none"}`);
        return await page.observe({
          instruction,
        });

      case "CLOSE":
        console.log(`[WORKER:${subtaskId}] Closing session`);
        await stagehand.close();
        break;

      case "SCREENSHOT": {
        console.log(`[WORKER:${subtaskId}] Taking screenshot`);
        const cdpSession = await page.context().newCDPSession(page);
        const { data } = await cdpSession.send("Page.captureScreenshot");
        return data;
      }

      case "WAIT":
        console.log(`[WORKER:${subtaskId}] Waiting for ${instruction}ms`);
        await new Promise((resolve) =>
          setTimeout(resolve, Number(instruction))
        );
        break;

      case "NAVBACK":
        console.log(`[WORKER:${subtaskId}] Navigating back`);
        await page.goBack();
        break;

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  } catch (error) {
    console.error(`[WORKER:${subtaskId}] Error during ${method}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    if (method !== "EXTRACT" && method !== "OBSERVE" && method !== "SCREENSHOT") {
      await stagehand.close();
    }
  }
}

/**
 * Executes a single subtask in the browser
 * 
 * @param subtaskId The ID of the subtask to execute
 * @param sessionId The browser session ID
 * @param overallGoal The overall task goal 
 * @param subtaskGoal The specific goal for this subtask
 * @param subtaskDescription A description of the subtask
 * @param taskPlan Optional context about how this subtask fits into the overall plan
 * @param previousExtraction Optional data extracted from a previous subtask
 * @param maxRetries Maximum number of retries for failed steps
 * @returns The result of the subtask execution
 */
export async function executeSubtask({
  subtaskId,
  sessionId,
  overallGoal,
  subtaskGoal,
  subtaskDescription,
  taskPlan,
  previousExtraction,
  maxRetries = 3
}: {
  subtaskId: string;
  sessionId: string;
  overallGoal: string;
  subtaskGoal: string;
  subtaskDescription: string;
  taskPlan?: {
    planDescription?: string;
    subtaskPosition?: number;
    totalSubtasks?: number;
    otherSubtasks?: Array<{
      id: string;
      goal: string;
      description: string;
      dependencies?: string[];
      status?: string;
    }>;
  };
  previousExtraction?: string | any;
  maxRetries?: number;
}): Promise<WorkerResult> {
  console.log(`[WORKER:${subtaskId}] Executing subtask ${subtaskId}`);
  console.log(`[WORKER:${subtaskId}] Goal: ${subtaskGoal}`);
  if (taskPlan) {
    console.log(`[WORKER:${subtaskId}] Position: ${taskPlan.subtaskPosition || '?'}/${taskPlan.totalSubtasks || '?'}`);
  }
  
  let steps: BrowserStep[] = [];
  let extraction: any = null;
  let retryCount = 0;
  let lastError: Error | null = null;
  let currentScreenshot: string | null = null;
  
  // Set maximum steps to prevent infinite loops
  const MAX_STEPS = 15;
  
  // Keep track of repeated actions to detect loops
  const recentActionHistory: Array<{ tool: string, instruction: string }> = [];
  const MAX_HISTORY = 5; // Number of actions to track
  const MAX_DUPLICATES = 2; // Maximum number of times the same action can be repeated

  function isRepeatingAction(step: BrowserStep): boolean {
    // Check if this step is a repeat of a recent action
    const duplicate = recentActionHistory.filter(
      history => history.tool === step.tool && history.instruction === step.instruction
    ).length;
    
    // Add current action to history
    recentActionHistory.push({
      tool: step.tool,
      instruction: step.instruction
    });
    
    // Keep history at MAX_HISTORY size
    if (recentActionHistory.length > MAX_HISTORY) {
      recentActionHistory.shift();
    }
    
    // Check if we've seen this action too many times
    return duplicate >= MAX_DUPLICATES;
  }
  
  try {
    // Get the current URL for context
    let currentUrl = '';
    try {
        throw new Error("Not implemented");
    //   const currentUrlResult = await executeStep({
    //     sessionId,
    //     subtaskId,
    //     step: {
    //       text: "Getting current URL",
    //       reasoning: "Need to know current state",
    //       tool: "EXTRACT",
    //       instruction: "return document.location.href",
    //     }
    //   });
      
    //   if (typeof currentUrlResult === 'string') {
    //     currentUrl = currentUrlResult;
    //   } else if (Array.isArray(currentUrlResult) && currentUrlResult.length > 0) {
    //     currentUrl = currentUrlResult[0].toString();
    //   }
    } catch (e) {
      console.warn(`[WORKER:${subtaskId}] Failed to get current URL, continuing without it`);
      currentUrl = 'unknown';
    }
    
    // Capture initial screenshot
    try {
      console.log(`[WORKER:${subtaskId}] Capturing initial screenshot for subtask ${subtaskId}`);
      currentScreenshot = await executeStep({
        sessionId,
        subtaskId,
        step: {
          text: "Capturing page screenshot",
          reasoning: "Need visual context of current state",
          tool: "SCREENSHOT",
          instruction: ""
        }
      }) as string;
      console.log(`[WORKER:${subtaskId}] Initial screenshot captured successfully`);
    } catch (e) {
      console.warn(`[WORKER:${subtaskId}] Failed to capture initial screenshot, continuing without it`, e);
      currentScreenshot = null;
    }
    
    // Execute steps until the subtask is complete or fails
    let isSubtaskComplete = false;
    
    while (!isSubtaskComplete) {
      try {
        // Check if we've exceeded the maximum number of steps
        if (steps.length >= MAX_STEPS) {
          console.log(`[WORKER:${subtaskId}] Subtask ${subtaskId} reached maximum steps limit (${MAX_STEPS}). Marking as failed.`);
          return {
            status: "FAILED",
            steps,
            error: `Exceeded maximum number of steps (${MAX_STEPS})`,
            retryCount
          };
        }
        
        // Get the next step from the agent
        const nextStep = await getNextStep({
          sessionId,
          subtaskId,
          overallGoal,
          subtaskGoal,
          subtaskDescription,
          taskPlan,
          previousSteps: steps,
          currentUrl,
          previousExtraction,
          screenshot: currentScreenshot
        });
        
        // Check for explicit DONE or FAIL actions
        if (nextStep.tool === "DONE") {
          console.log(`[WORKER:${subtaskId}] Agent explicitly marked subtask as DONE: ${nextStep.instruction}`);
          steps.push(nextStep);
          return {
            status: "DONE",
            steps,
            extraction,
            retryCount
          };
        }
        
        if (nextStep.tool === "FAIL") {
          console.log(`[WORKER:${subtaskId}] Agent explicitly marked subtask as FAILED: ${nextStep.instruction}`);
          steps.push(nextStep);
          return {
            status: "FAILED",
            steps,
            error: nextStep.instruction,
            retryCount
          };
        }
        
        // Check if this step is a repeat of recent actions
        if (isRepeatingAction(nextStep)) {
          console.log(`[WORKER:${subtaskId}] Detected repeated action: ${nextStep.tool} - ${nextStep.instruction.substring(0, 50)}...`);
          console.log(`[WORKER:${subtaskId}] This is likely a loop. Incrementing retry counter.`);
          
          retryCount++;
          if (retryCount >= maxRetries) {
            console.log(`[WORKER:${subtaskId}] Subtask ${subtaskId} failed after ${retryCount} attempts due to action loop`);
            return {
              status: "FAILED",
              steps,
              error: `Failed due to repeating the same action (${nextStep.tool}) ${retryCount} times`,
              retryCount
            };
          }
          
          // Add a variation to the prompt to break out of the loop
          steps.push({
            text: "Detected repeated action",
            reasoning: "The same action was attempted multiple times without progress",
            tool: "WAIT" as const,
            instruction: "Pausing to reassess strategy"
          });
          
          // Update the screenshot to ensure we have the latest state
          try {
            console.log(`[WORKER:${subtaskId}] Capturing fresh screenshot to break loop`);
            currentScreenshot = await executeStep({
              sessionId,
              subtaskId,
              step: {
                text: "Capturing fresh screenshot",
                reasoning: "Need updated visual context to break loop",
                tool: "SCREENSHOT",
                instruction: ""
              }
            }) as string;
          } catch (e) {
            console.warn(`[WORKER:${subtaskId}] Failed to capture fresh screenshot`, e);
          }
          
          // Wait briefly before retrying
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        
        // Add the step to our list
        steps.push(nextStep);
        
        // If the agent decides the subtask is complete, stop
        if (nextStep.text.toLowerCase().includes("task complete") || 
            nextStep.text.toLowerCase().includes("goal achieved") ||
            nextStep.text.toLowerCase().includes("subtask complete") ||
            nextStep.reasoning.toLowerCase().includes("task complete") ||
            nextStep.reasoning.toLowerCase().includes("goal achieved") ||
            nextStep.reasoning.toLowerCase().includes("subtask complete")) {
          console.log(`[WORKER:${subtaskId}] Subtask ${subtaskId} completed successfully based on text/reasoning`);
          
          // Add an explicit DONE step
          const doneStep: BrowserStep = {
            text: "Marking subtask as complete",
            reasoning: "Based on completion signals in previous step",
            tool: "DONE",
            instruction: "Subtask successfully completed"
          };
          
          steps.push(doneStep);
          
          return {
            status: "DONE",
            steps,
            extraction,
            retryCount
          };
        }
        
        // Execute the step
        if (nextStep.tool !== "CLOSE") {
          console.log(`[WORKER:${subtaskId}] Executing step: ${nextStep.tool} - ${nextStep.instruction.substring(0, 50)}${nextStep.instruction.length > 50 ? '...' : ''}`);
          const result = await executeStep({
            sessionId,
            subtaskId,
            step: nextStep
          });
          
          // Remember extractions for context
          if (nextStep.tool === "EXTRACT" && result) {
            extraction = result;
            previousExtraction = result;
          }
          
          // Update currentUrl if this was a navigation action
          if (nextStep.tool === "GOTO" || nextStep.tool === "NAVBACK") {
            try {
              const currentUrlResult = await executeStep({
                sessionId,
                subtaskId,
                step: {
                  text: "Getting current URL after navigation",
                  reasoning: "Need to update current state",
                  tool: "EXTRACT",
                  instruction: "return document.location.href",
                }
              });
              
              if (typeof currentUrlResult === 'string') {
                currentUrl = currentUrlResult;
              } else if (Array.isArray(currentUrlResult) && currentUrlResult.length > 0) {
                currentUrl = currentUrlResult[0].toString();
              }
            } catch (e) {
              console.warn(`[WORKER:${subtaskId}] Failed to get current URL after navigation, continuing with old one`);
            }
          }
          
          // Always capture a screenshot after each step (unless it was already a screenshot step)
          if (nextStep.tool !== "SCREENSHOT") {
            try {
              console.log(`[WORKER:${subtaskId}] Capturing updated screenshot after ${nextStep.tool}`);
              currentScreenshot = await executeStep({
                sessionId,
                subtaskId,
                step: {
                  text: "Capturing updated screenshot",
                  reasoning: "Need updated visual context after action",
                  tool: "SCREENSHOT",
                  instruction: ""
                }
              }) as string;
              console.log(`[WORKER:${subtaskId}] Updated screenshot captured successfully`);
            } catch (e) {
              console.warn(`[WORKER:${subtaskId}] Failed to capture updated screenshot, continuing with previous one`, e);
              // Keep using the previous screenshot if this fails
            }
          } else {
            // If the step itself was a screenshot, use its result
            currentScreenshot = result as string;
          }
        } else {
          console.log(`[WORKER:${subtaskId}] Worker tried to use CLOSE tool but this is not allowed. Converting to DONE.`);
          
          // Convert CLOSE to DONE
          const doneStep: BrowserStep = {
            text: "Marking subtask as complete",
            reasoning: "Based on CLOSE request from agent",
            tool: "DONE",
            instruction: "Subtask successfully completed"
          };
          
          steps.push(doneStep);
          
          return {
            status: "DONE", 
            steps,
            extraction,
            retryCount
          };
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(`[WORKER:${subtaskId}] Error executing step:`, error);
        
        retryCount++;
        if (retryCount >= maxRetries) {
          console.log(`[WORKER:${subtaskId}] Subtask ${subtaskId} failed after ${retryCount} attempts`);
          
          // Add an explicit FAIL step
          const failStep: BrowserStep = {
            text: "Marking subtask as failed",
            reasoning: "Exceeded maximum retry attempts",
            tool: "FAIL",
            instruction: lastError.message
          };
          
          steps.push(failStep);
          
          return {
            status: "FAILED",
            steps,
            error: lastError.message,
            retryCount
          };
        }
        
        console.log(`[WORKER:${subtaskId}] Retrying (${retryCount}/${maxRetries})...`);
        // Wait a moment before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Try to get a fresh screenshot before the retry
        try {
          console.log(`[WORKER:${subtaskId}] Capturing recovery screenshot before retry`);
          currentScreenshot = await executeStep({
            sessionId,
            subtaskId,
            step: {
              text: "Capturing recovery screenshot",
              reasoning: "Need visual context before retry attempt",
              tool: "SCREENSHOT",
              instruction: ""
            }
          }) as string;
        } catch (e) {
          console.warn(`[WORKER:${subtaskId}] Failed to capture recovery screenshot, continuing with previous one`, e);
        }
      }
    }
    
    // If we reach here, the subtask completed successfully
    console.log(`[WORKER:${subtaskId}] Subtask completed successfully (end of execution loop)`);
    
    // Add a final DONE step
    const finalDoneStep: BrowserStep = {
      text: "Marking subtask as complete",
      reasoning: "Reached the end of execution successfully",
      tool: "DONE",
      instruction: "Subtask successfully completed"
    };
    
    steps.push(finalDoneStep);
    
    return {
      status: "DONE",
      steps,
      extraction,
      retryCount
    };
    
  } catch (error) {
    lastError = error instanceof Error ? error : new Error(String(error));
    console.error(`[WORKER:${subtaskId}] Fatal error executing subtask:`, error);
    
    // Add a final FAIL step
    const finalFailStep: BrowserStep = {
      text: "Marking subtask as failed",
      reasoning: "Fatal error occurred",
      tool: "FAIL",
      instruction: lastError.message
    };
    
    steps.push(finalFailStep);
    
    return {
      status: "FAILED",
      steps,
      error: lastError.message,
      retryCount
    };
  }
}

/**
 * Executes a single step in the browser
 * 
 * @param sessionId The ID of the browser session 
 * @param step The step to execute
 * @returns The result of the step execution
 */
async function executeStep({
  sessionId,
  subtaskId,
  step
}: {
  sessionId: string;
  subtaskId: string;
  step: BrowserStep;
}): Promise<string | ObserveResult[] | any> {
  console.log(`[WORKER:${subtaskId}] Executing ${step.tool}: ${step.instruction.substring(0, 50)}${step.instruction.length > 50 ? '...' : ''}`);
  
  // Execute the step
  return await runStagehand({
    sessionID: sessionId,
    subtaskId,
    method: step.tool,
    instruction: step.instruction,
  });
}

/**
 * Checks if the previous steps indicate the worker might be stuck in a loop
 */
function hasPossibleLoop(steps: BrowserStep[]): boolean {
  if (steps.length < 3) return false;
  
  // Get the last 3 steps
  const recentSteps = steps.slice(-3);
  
  // Check if all recent steps use the same tool
  const allSameTool = recentSteps.every(step => step.tool === recentSteps[0].tool);
  
  // Check for exact instruction repetition
  const uniqueInstructions = new Set(recentSteps.map(step => step.instruction));
  const hasRepeatedInstructions = uniqueInstructions.size < recentSteps.length;
  
  // Check for phrases that indicate being stuck
  const stuckPhrases = ["still", "again", "retry", "same", "another attempt", "try once more"];
  const containsStuckPhrases = recentSteps.some(step => 
    stuckPhrases.some(phrase => 
      step.text.toLowerCase().includes(phrase) || 
      step.reasoning.toLowerCase().includes(phrase)
    )
  );
  
  return (allSameTool && hasRepeatedInstructions) || containsStuckPhrases;
}

/**
 * Gets the next step to execute from the agent
 */
async function getNextStep({
  sessionId,
  subtaskId,
  overallGoal,
  subtaskGoal,
  subtaskDescription,
  taskPlan,
  previousSteps = [],
  currentUrl,
  previousExtraction,
  screenshot
}: {
  sessionId: string;
  subtaskId: string;
  overallGoal: string;
  subtaskGoal: string;
  subtaskDescription: string;
  taskPlan?: {
    planDescription?: string;
    subtaskPosition?: number;
    totalSubtasks?: number;
    otherSubtasks?: Array<{
      id: string;
      goal: string;
      description: string;
      dependencies?: string[];
      status?: string;
    }>;
  };
  previousSteps: BrowserStep[];
  currentUrl: string;
  previousExtraction?: string | any;
  screenshot: string | null;
}): Promise<BrowserStep> {
  // Prepare the text prompt
  const textPrompt = `
OVERALL TASK GOAL: ${overallGoal}
${taskPlan?.planDescription ? `PLAN DESCRIPTION: ${taskPlan.planDescription}` : ''}

YOUR SUBTASK GOAL: ${subtaskGoal}
SUBTASK DESCRIPTION: ${subtaskDescription}
${taskPlan?.subtaskPosition ? `YOUR SUBTASK POSITION: ${taskPlan.subtaskPosition} of ${taskPlan.totalSubtasks || '?'}` : ''}

HOW THIS SUBTASK FITS INTO THE OVERALL PLAN:
This subtask is one part of achieving the overall goal. Your work will contribute to the larger task by:
- Helping gather necessary information for later steps
- Setting up foundations that other subtasks will build upon
- Working towards the end result in a systematic way

${taskPlan?.otherSubtasks && taskPlan.otherSubtasks.length > 0 ? `
OTHER SUBTASKS IN THE PLAN:
${taskPlan.otherSubtasks.map(st => `- ${st.goal}${st.dependencies?.includes(subtaskId) ? ' (depends on your subtask)' : ''}`).join('\n')}
` : ''}

Even if your subtask instructions seem vague, consider how they relate to the overall goal.
You should adapt your approach based on what you observe in the current state of the browser.
If you encounter unexpected situations, think about what would be most helpful for the overall task.

${previousSteps.length > 0 ? `\nPREVIOUS STEPS YOU'VE TAKEN:
${previousSteps.map((step, i) => `Step ${i + 1}: ${step.text}
Tool: ${step.tool}
Instruction: ${step.instruction}
Reasoning: ${step.reasoning}`).join('\n\n')}` : ''}
${previousExtraction ? `\nPREVIOUS EXTRACTION:
${JSON.stringify(previousExtraction, null, 2)}` : ''}

CURRENT URL: ${currentUrl}

${hasPossibleLoop(previousSteps) ? `WARNING: You appear to be repeating similar actions without making progress. Try a completely different approach to achieve your goal. Consider:
1. Using a different tool (if you've been using OBSERVE, try ACT or EXTRACT)
2. Looking at different parts of the page in the screenshot
3. Trying a different interaction method
4. Navigating to a different page if options are exhausted on this one
` : ''}

Determine the next step to achieve the subtask goal. Remember:
1. You can use these tools: ACT, EXTRACT, OBSERVE, WAIT, NAVBACK, SCREENSHOT, DONE, FAIL
2. Be specific and detailed in your instructions
3. Provide clear reasoning for your chosen step
4. If the goal is achieved, use the DONE tool to mark the subtask as complete
5. If you encounter an error that can't be resolved, use the FAIL tool

IMPORTANT: Use the DONE tool when the subtask is complete with a message explaining what was accomplished.
Use the FAIL tool when the subtask has encountered a critical error that cannot be resolved.

REFLECTION BEFORE ACTING:
Before deciding on your next action, reflect on these questions:
1. What is the current state of the browser (based on the screenshot)?
2. How does this current state relate to my subtask goal?
3. What is the most direct path to completing my subtask from here?
4. How will my completion of this subtask help the overall task?
5. Are there any potential obstacles I should anticipate?
6. How should I adapt if my expected path is blocked?

You are provided with a screenshot of the current page state. This screenshot is updated after each action you take, so it always reflects the current state of the page. 
EXAMINE the screenshot CAREFULLY before deciding your next action. The screenshot contains the most accurate information about the page.

Respond in the following format:
{
  "text": "<what you're doing in this step>",
  "reasoning": "<your reasoning for this step>",
  "tool": "<the tool to use: ACT, EXTRACT, OBSERVE, WAIT, NAVBACK, SCREENSHOT, DONE, FAIL>",
  "instruction": "<the specific instruction for the tool>"
}
`;

  try {
    // Use basic user content array approach that works with the existing types
    const content: UserContent = [
      { type: "text", text: textPrompt }
    ];
    
    // Add screenshot to content if available
    if (screenshot) {
      content.push({ 
        type: "image", 
        image: screenshot
      }); 
    }
    
    // Create the messages
    const messages: CoreMessage[] = [
      { 
        role: "system", 
        content: WORKER_PROMPT
      },
      {
        role: "user",
        content
      }
    ];
    
    // Generate the next step
    const result = await generateObject({
      model: WorkerLLM,
      messages,
      schema: z.object({
        text: z.string().describe("A concise description of what action to take next"),
        reasoning: z.string().describe("Your reasoning for choosing this action, referring specifically to what you observe in the screenshot and how it relates to the overall task"),
        tool: z.enum(["GOTO", "ACT", "EXTRACT", "OBSERVE", "CLOSE", "WAIT", "NAVBACK", "SCREENSHOT", "DONE", "FAIL"]).describe("The tool to use for this step"),
        instruction: z.string().describe("The specific instruction for the selected tool")
      }),
    });

    // Extract the step from the result
    const nextStep: BrowserStep = {
      text: result.object.text,
      reasoning: result.object.reasoning,
      tool: result.object.tool,
      instruction: result.object.instruction
    };
    
    // If the LLM indicates the subtask is complete in the text or reasoning,
    // but didn't use DONE tool, convert it to a DONE step
    if (
      nextStep.tool !== "DONE" &&
      (nextStep.text.toLowerCase().includes("task complete") || 
      nextStep.text.toLowerCase().includes("goal achieved") ||
      nextStep.text.toLowerCase().includes("subtask complete") ||
      nextStep.reasoning.toLowerCase().includes("task complete") ||
      nextStep.reasoning.toLowerCase().includes("goal achieved") ||
      nextStep.reasoning.toLowerCase().includes("subtask complete"))
    ) {
      console.log(`[WORKER:${subtaskId}] Detected completion language but no DONE tool, converting to DONE`);
      return {
        text: "Subtask completed successfully",
        reasoning: "The goal for this subtask has been achieved",
        tool: "DONE" as const,
        instruction: "Subtask complete: " + nextStep.text
      };
    }
    
    return nextStep;
  } catch (error) {
    console.error(`[WORKER:${subtaskId}] Error generating next step:`, error);
    // Fallback to a safe action if generation fails
    return {
      text: "Failed to determine next step, taking a screenshot to reassess",
      reasoning: "Error occurred in step generation, need to capture current state to recover",
      tool: "SCREENSHOT",
      instruction: ""
    };
  }
} 