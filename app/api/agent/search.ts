import { google } from "@ai-sdk/google";
import { generateText } from "ai";
import { GEMINI_SEARCH_PROMPT } from "./prompts";

const model = google("gemini-2.0-flash", {
  useSearchGrounding: true,
});

/**
 * Search agent that uses Gemini with search grounding to gather information about the task
 * 
 * @param task The user's task description
 * @returns An object containing the search results and context
 */
export async function searchForTaskContext(task: string): Promise<{ searchContext: string }> {
  try {
    // Create a prompt that asks Gemini to search for information about the task
    const prompt = `${GEMINI_SEARCH_PROMPT}\n\n${task}`;
    
    // Generate text using Gemini with search grounding
    const result = await generateText({
        model: model,
        messages: [
            { role: "system", content: GEMINI_SEARCH_PROMPT },
            { role: "user", content: prompt },
        ]
    });
    
    return {
      searchContext: result.text
    };
  } catch (error: unknown) {
    console.error("Error in search agent:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Search agent failed: ${errorMessage}`);
  }
} 