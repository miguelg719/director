"use client";

import { motion } from "framer-motion";
import { useState, useEffect, useCallback, useRef } from "react";
import { useWindowSize } from "usehooks-ts";
import Image from "next/image";
import { useAtom } from "jotai/react";
import { contextIdAtom } from "../atoms";
import posthog from "posthog-js";
interface ChatFeedProps {
  initialMessage?: string;
  onClose: () => void;
  url?: string;
}

export interface BrowserStep {
  text: string;
  reasoning: string;
  tool: "GOTO" | "ACT" | "EXTRACT" | "OBSERVE" | "CLOSE" | "WAIT" | "NAVBACK";
  instruction: string;
  stepNumber?: number;
}

interface AgentState {
  sessionId: string | null;
  sessionUrl: string | null;
  steps: BrowserStep[];
  isLoading: boolean;
}

export default function ChatFeed({ initialMessage, onClose }: ChatFeedProps) {
  const [isLoading, setIsLoading] = useState(false);
  const { width } = useWindowSize();
  const isMobile = width ? width < 768 : false;
  const initializationRef = useRef(false);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [isAgentFinished, setIsAgentFinished] = useState(false);
  const [contextId, setContextId] = useAtom(contextIdAtom);
  const agentStateRef = useRef<AgentState>({
    sessionId: null,
    sessionUrl: null,
    steps: [],
    isLoading: false,
  });

  const [uiState, setUiState] = useState<{
    sessionId: string | null;
    sessionUrl: string | null;
    steps: BrowserStep[];
  }>({
    sessionId: null,
    sessionUrl: null,
    steps: [],
  });

  const scrollToBottom = useCallback(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop =
        chatContainerRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    if (
      uiState.steps.length > 0 &&
      uiState.steps[uiState.steps.length - 1].tool === "CLOSE"
    ) {
      setIsAgentFinished(true);
      fetch("/api/session", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: uiState.sessionId,
        }),
      });
    }
  }, [uiState.sessionId, uiState.steps]);

  useEffect(() => {
    scrollToBottom();
  }, [uiState.steps, scrollToBottom]);

  useEffect(() => {
    console.log("useEffect called");
    const initializeSession = async () => {
      if (initializationRef.current) return;
      initializationRef.current = true;

      if (initialMessage && !agentStateRef.current.sessionId) {
        setIsLoading(true);
        try {
          // 1. Create a browser session
          const sessionResponse = await fetch("/api/session", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              contextId: contextId,
            }),
          });
          const sessionData = await sessionResponse.json();

          if (!sessionData.success) {
            throw new Error(sessionData.error || "Failed to create session");
          }

          setContextId(sessionData.contextId);

          // Update the session information
          const sessionUrl = sessionData.sessionUrl.replace(
            "https://www.browserbase.com/devtools-fullscreen/inspector.html",
            "https://www.browserbase.com/devtools-internal-compiled/index.html"
          );

          agentStateRef.current = {
            ...agentStateRef.current,
            sessionId: sessionData.sessionId,
            sessionUrl: sessionUrl,
          };

          setUiState({
            sessionId: sessionData.sessionId,
            sessionUrl: sessionUrl,
            steps: [],
          });

          // Show UI message that we're starting
          const startingStep: BrowserStep = {
            text: "Starting task...",
            reasoning: "The agent is preparing to execute the task",
            tool: "WAIT" as const,
            instruction: "Starting",
            stepNumber: 1,
          };

          agentStateRef.current = {
            ...agentStateRef.current,
            steps: [startingStep],
          };

          setUiState(prev => ({
            ...prev,
            steps: [startingStep],
          }));

          // 2. Handle first step with URL selection (use the existing START action)
          const startResponse = await fetch("/api/agent", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              goal: initialMessage,
              sessionId: sessionData.sessionId,
              action: "START",
            }),
          });

          const startData = await startResponse.json();
          
          if (!startData.success) {
            throw new Error(startData.error || "Failed to start task");
          }

          posthog.capture("agent_start", {
            goal: initialMessage,
            sessionId: sessionData.sessionId,
            contextId: sessionData.contextId,
          });

          // Update UI with the first step (showing the URL navigation to the user)
          const firstStep = {
            ...startData.result,
            stepNumber: 1,
          };

          agentStateRef.current = {
            ...agentStateRef.current,
            steps: [firstStep],
          };

          setUiState(prev => ({
            ...prev,
            steps: [firstStep],
          }));

          // Create a plan in the background (for internal execution)
          console.log("[VERBOSE] Creating plan...");
          const planResponse = await fetch("/api/agent", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              goal: initialMessage,
              sessionId: sessionData.sessionId,
              action: "PLAN_TASK",
            }),
          });

          const planData = await planResponse.json();
          
          if (!planData.success) {
            console.error("[ERROR] Failed to create plan:", planData.error);
            // Continue with the legacy flow if planning fails
            await legacyStepExecution(sessionData, initialMessage);
            return;
          }

          console.log("[VERBOSE] Plan created:", planData);
          
          // 3. Execute the plan using the worker architecture
          let taskCompleted = false;
          const taskId = planData.taskId;
          let visibleSteps = [...agentStateRef.current.steps];
          let stepCounter = visibleSteps.length;

          while (!taskCompleted) {
            // Request a worker task
            const workerResponse = await fetch("/api/agent", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                taskId,
                workerId: "worker-1",
                action: "GET_WORKER_TASK",
              }),
            });

            const workerData = await workerResponse.json();

            if (!workerData.success) {
              console.error("[ERROR] Failed to get worker task:", workerData.error);
              throw new Error(workerData.error || "Failed to get worker task");
            }

            // Check if there are no more tasks
            if (!workerData.hasTask) {
              // Check task status
              const statusResponse = await fetch("/api/agent", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  taskId,
                  action: "GET_TASK_STATUS",
                }),
              });

              const statusData = await statusResponse.json();
              
              if (statusData.status === 'DONE' || statusData.status === 'FAILED') {
                taskCompleted = true;
                console.log(`[VERBOSE] Task ${statusData.status.toLowerCase()}`);
                
                if (statusData.status === 'DONE') {
                  // Add a final step only if not already completed
                  if (!visibleSteps.some(step => step.tool === "CLOSE")) {
                    const finalStep: BrowserStep = {
                      text: "Task completed successfully",
                      reasoning: "The agent has completed all subtasks",
                      tool: "CLOSE" as const,
                      instruction: "Closing session",
                      stepNumber: ++stepCounter,
                    };
                    
                    visibleSteps.push(finalStep);
                    agentStateRef.current = {
                      ...agentStateRef.current,
                      steps: visibleSteps,
                    };
                    
                    setUiState(prev => ({
                      ...prev,
                      steps: visibleSteps,
                    }));
                  }
                }
                
                setIsAgentFinished(true);
              }
              
              // Wait a bit before checking again
              await new Promise(resolve => setTimeout(resolve, 1000));
              continue;
            }

            // Execute the subtask
            console.log(`[VERBOSE] Executing subtask: ${workerData.subtaskId}`, workerData);
            const { subtaskId, overallGoal, subtaskGoal, subtaskDescription } = workerData;
            
            const executeResponse = await fetch("/api/agent", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                taskId,
                workerId: "worker-1",
                subtaskId,
                sessionId: sessionData.sessionId,
                overallGoal,
                subtaskGoal,
                subtaskDescription,
                action: "EXECUTE_WORKER_TASK",
              }),
            });

            const executeData = await executeResponse.json();
            
            if (!executeData.success) {
              console.error("[ERROR] Failed to execute worker task:", executeData.error);
              throw new Error(executeData.error || "Failed to execute worker task");
            }

            console.log(`[VERBOSE] Subtask ${subtaskId} completed:`, executeData.result);

            posthog.capture("agent_subtask_complete", {
              goal: initialMessage,
              sessionId: sessionData.sessionId,
              contextId: sessionData.contextId,
              taskId,
              subtaskId,
              status: executeData.result.status,
            });

            // Update UI with visible steps from this subtask
            // We'll only show the most important steps to the user
            const subtaskSteps = executeData.result.steps;
            if (subtaskSteps && subtaskSteps.length > 0) {
              // Filter to just show non-internal steps (ACT, EXTRACT, GOTO) to the user
              const visibleSubtaskSteps = subtaskSteps
                .filter((step: BrowserStep) => 
                  ["ACT", "EXTRACT", "GOTO", "CLOSE"].includes(step.tool))
                .map((step: BrowserStep, i: number) => ({
                  ...step,
                  stepNumber: stepCounter + i + 1
                }));
                
              if (visibleSubtaskSteps.length > 0) {
                stepCounter += visibleSubtaskSteps.length;
                visibleSteps = [...visibleSteps, ...visibleSubtaskSteps];
                
                agentStateRef.current = {
                  ...agentStateRef.current,
                  steps: visibleSteps,
                };
                
                setUiState(prev => ({
                  ...prev,
                  steps: visibleSteps,
                }));
              }
            }
          }
        } catch (error: unknown) {
          console.error("Session initialization error:", error);
          
          // Attempt to execute using the legacy flow if there's an error
          if (agentStateRef.current.sessionId) {
            try {
              await legacyStepExecution(
                { sessionId: agentStateRef.current.sessionId, contextId: contextId },
                initialMessage
              );
              return;
            } catch (fallbackError) {
              console.error("Legacy execution also failed:", fallbackError);
            }
          }
          
          const errorStep: BrowserStep = {
            text: `Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`,
            reasoning: "The agent encountered an error",
            tool: "CLOSE" as const,
            instruction: "Error",
            stepNumber: agentStateRef.current.steps.length + 1,
          };
          
          agentStateRef.current = {
            ...agentStateRef.current,
            steps: [...agentStateRef.current.steps, errorStep],
          };

          setUiState(prev => ({
            ...prev,
            steps: [...agentStateRef.current.steps],
          }));
          
          setIsAgentFinished(true);
        } finally {
          setIsLoading(false);
        }
      }
    };

    // Legacy step execution for backward compatibility
    const legacyStepExecution = async (
      sessionData: { sessionId: string, contextId: string },
      goal: string
    ) => {
      console.log("[VERBOSE] Falling back to legacy execution");
      try {
        // Continue with legacy workflow using GET_NEXT_STEP and EXECUTE_STEP actions
        while (true) {
          // Get next step from LLM
          const nextStepResponse = await fetch("/api/agent", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              goal,
              sessionId: sessionData.sessionId,
              previousSteps: agentStateRef.current.steps,
              action: "GET_NEXT_STEP",
            }),
          });

          const nextStepData = await nextStepResponse.json();

          if (!nextStepData.success) {
            throw new Error("Failed to get next step");
          }

          // Add step number and add to steps array
          const nextStep = {
            ...nextStepData.result,
            stepNumber: agentStateRef.current.steps.length + 1,
          };

          agentStateRef.current = {
            ...agentStateRef.current,
            steps: [...agentStateRef.current.steps, nextStep],
          };

          setUiState(prev => ({
            ...prev,
            steps: [...agentStateRef.current.steps],
          }));

          // Break after adding the CLOSE step to UI
          if (nextStepData.done || nextStepData.result.tool === "CLOSE") {
            setIsAgentFinished(true);
            break;
          }

          // Execute the step
          const executeResponse = await fetch("/api/agent", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              sessionId: sessionData.sessionId,
              step: nextStepData.result,
              action: "EXECUTE_STEP",
            }),
          });

          const executeData = await executeResponse.json();

          posthog.capture("agent_execute_step", {
            goal,
            sessionId: sessionData.sessionId,
            contextId: sessionData.contextId,
            step: nextStepData.result,
          });

          if (!executeData.success) {
            throw new Error("Failed to execute step");
          }

          if (executeData.done) {
            setIsAgentFinished(true);
            break;
          }
        }
      } catch (error) {
        console.error("Legacy execution error:", error);
        throw error;
      }
    };

    initializeSession();
  }, [initialMessage]);

  // Spring configuration for smoother animations
  const springConfig = {
    type: "spring",
    stiffness: 350,
    damping: 30,
  };

  const containerVariants = {
    hidden: { opacity: 0, scale: 0.95 },
    visible: {
      opacity: 1,
      scale: 1,
      transition: {
        ...springConfig,
        staggerChildren: 0.1,
      },
    },
    exit: {
      opacity: 0,
      scale: 0.95,
      transition: { duration: 0.2 },
    },
  };

  const messageVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -20 },
  };

  return (
    <motion.div
      className="min-h-screen bg-gray-50 flex flex-col"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <motion.nav
        className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-200 shadow-sm"
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
      >
        <div className="flex items-center gap-2">
          <Image
            src="/favicon.svg"
            alt="Open Operator"
            className="w-8 h-8"
            width={32}
            height={32}
          />
          <span className="font-ppneue text-gray-900">Open Operator</span>
        </div>
        <motion.button
          onClick={onClose}
          className="px-4 py-2 hover:bg-gray-100 text-gray-600 hover:text-gray-900 transition-colors rounded-md font-ppsupply flex items-center gap-2"
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          Close
          {!isMobile && (
            <kbd className="px-2 py-1 text-xs bg-gray-100 rounded-md">ESC</kbd>
          )}
        </motion.button>
      </motion.nav>
      <main className="flex-1 flex flex-col items-center p-6">
        <motion.div
          className="w-full max-w-[1280px] bg-white border border-gray-200 shadow-sm rounded-lg overflow-hidden"
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.3 }}
        >
          <div className="w-full h-12 bg-white border-b border-gray-200 flex items-center px-4">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-500" />
              <div className="w-3 h-3 rounded-full bg-yellow-500" />
              <div className="w-3 h-3 rounded-full bg-green-500" />
            </div>
          </div>

          {(() => {
            console.log("Session URL:", uiState.sessionUrl);
            return null;
          })()}

          <div className="flex flex-col md:flex-row">
            {uiState.sessionUrl && !isAgentFinished && (
              <div className="flex-1 p-6 border-b md:border-b-0 md:border-l border-gray-200 order-first md:order-last">
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.4 }}
                  className="w-full aspect-video"
                >
                  <iframe
                    src={uiState.sessionUrl}
                    className="w-full h-full"
                    sandbox="allow-same-origin allow-scripts allow-forms"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    title="Browser Session"
                  />
                </motion.div>
              </div>
            )}

            {isAgentFinished && (
              <div className="flex-1 p-6 border-b md:border-b-0 md:border-l border-gray-200 order-first md:order-last">
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.4 }}
                  className="w-full aspect-video"
                >
                  <div className="w-full h-full border border-gray-200 rounded-lg flex items-center justify-center">
                    <p className="text-gray-500 text-center">
                      The agent has completed the task
                      <br />
                      &quot;{initialMessage}&quot;
                    </p>
                  </div>
                </motion.div>
              </div>
            )}

            <div className="md:w-[400px] p-6 min-w-0 md:h-[calc(56.25vw-3rem)] md:max-h-[calc(100vh-12rem)]">
              <div
                ref={chatContainerRef}
                className="h-full overflow-y-auto space-y-4"
              >
                {initialMessage && (
                  <motion.div
                    variants={messageVariants}
                    className="p-4 bg-blue-50 rounded-lg font-ppsupply"
                  >
                    <p className="font-semibold">Goal:</p>
                    <p>{initialMessage}</p>
                  </motion.div>
                )}

                {uiState.steps.map((step, index) => (
                  <motion.div
                    key={index}
                    variants={messageVariants}
                    className="p-4 bg-white border border-gray-200 rounded-lg font-ppsupply space-y-2"
                  >
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-500">
                        Step {step.stepNumber}
                      </span>
                      <span className="px-2 py-1 bg-gray-100 rounded text-xs">
                        {step.tool}
                      </span>
                    </div>
                    <p className="font-medium">{step.text}</p>
                    <p className="text-sm text-gray-600">
                      <span className="font-semibold">Reasoning: </span>
                      {step.reasoning}
                    </p>
                  </motion.div>
                ))}
                {isLoading && (
                  <motion.div
                    variants={messageVariants}
                    className="p-4 bg-gray-50 rounded-lg font-ppsupply animate-pulse"
                  >
                    Processing...
                  </motion.div>
                )}
              </div>
            </div>
          </div>
        </motion.div>
      </main>
    </motion.div>
  );
}
