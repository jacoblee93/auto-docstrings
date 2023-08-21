import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import weaviate from "weaviate-ts-client";

import { ChatPromptTemplate, HumanMessagePromptTemplate, SystemMessagePromptTemplate } from "langchain/prompts";
import { ChatOpenAI } from "langchain/chat_models/openai";

import { JsonOutputFunctionsParser } from "langchain/output_parsers";
import { createRetrieverTool } from "langchain/agents/toolkits";
import { WeaviateStore } from "langchain/vectorstores/weaviate";
import { OpenAIEmbeddings } from "langchain/embeddings/openai";
import { OpenAIAgentTokenBufferMemory } from "langchain/agents/toolkits";
import { RunnablePassthrough, RunnableSequence } from "langchain/schema/runnable";
import { initializeAgentExecutorWithOptions } from "langchain/agents";

import { COMMENT_GENERATION_HUMAN_TEMPLATE, COMMENT_GENERATION_SYSTEM_TEMPLATE, RESEARCH_AGENT_PREFIX } from "./prompts.js";

// Something wrong with the weaviate-ts-client types, so we need to disable
const client = (weaviate as any).client({
  scheme: process.env.WEAVIATE_SCHEME || "https",
  host: process.env.WEAVIATE_HOST || "localhost",
  apiKey: new (weaviate as any).ApiKey(
    process.env.WEAVIATE_API_KEY || "default"
  ),
});

const vectorStore = await WeaviateStore.fromExistingIndex(new OpenAIEmbeddings(), {
  indexName: "LangChain_idx",
  client
});

const tool = createRetrieverTool(vectorStore.asRetriever(), {
  name: "search_langchain_knowledge",
  description: "Searches and returns documents about LangChain's modules.",
});

export async function createGenerateCommentsChain(): Promise<RunnableSequence> {
  const memory = new OpenAIAgentTokenBufferMemory({
    llm: new ChatOpenAI({}),
    memoryKey: "chat_history",
    outputKey: "output",
  });

  // Initialize outside of the function scope to reuse documents and context retrieved from
  // processing prior files. Move into the function to save tokens.
  const researchAgentExecutor = await initializeAgentExecutorWithOptions([tool], new ChatOpenAI({
    // modelName: "gpt-3.5-turbo-16k",
    modelName: "gpt-4",
    temperature: 0.1,
  }), {
    agentType: "openai-functions",
    memory,
    returnIntermediateSteps: true,
    agentArgs: {
      prefix: RESEARCH_AGENT_PREFIX,
    },
  });


  const prompt = ChatPromptTemplate.fromPromptMessages<{input: string, context: string}>([
    SystemMessagePromptTemplate.fromTemplate(COMMENT_GENERATION_SYSTEM_TEMPLATE),
    HumanMessagePromptTemplate.fromTemplate(COMMENT_GENERATION_HUMAN_TEMPLATE),
  ]);

  const schema = z.object({
    ts_doc_comments: z.array(z.object({
      text: z.string().describe("The full TSDoc text, including newlines"),
      name: z.string().describe("The method or class name"),
      type: z.enum(["method", "class", "type", "interface", "function"]),
      params: z.array(z.object({
        name: z.string().describe("The name of the param"),
        description: z.string().describe("A description of the parameter"),
      })).describe("For methods, a list of parameters the method takes. Should contain all information to render as an @param declaration. Should be empty for non-methods"),
      returns: z.optional(z.string()).describe("For methods, information on what the method returns")
    }))
  });

  const functionCallingModel = new ChatOpenAI({
    modelName: "gpt-4",
    temperature: 0.1,
  }).bind({
    functions: [{
      name: "comment_inserter",
      description: "Inserts TSDoc comments into code based on input arguments",
      parameters: zodToJsonSchema(schema),
    }],
    function_call: { name: "comment_inserter" }
  });

  return RunnableSequence.from([
    {
      original_input: new RunnablePassthrough(),
      retrievalResult: researchAgentExecutor
    },
    {
      input: ({ original_input }) => original_input.input,
      context: ({ retrievalResult }) => retrievalResult.output,
    },
    prompt,
    functionCallingModel,
    new JsonOutputFunctionsParser()
  ]);
}