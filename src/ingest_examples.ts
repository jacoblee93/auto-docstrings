import "dotenv/config";
import { GithubRepoLoader } from "langchain/document_loaders/web/github";
import { FaissStore } from "langchain/vectorstores/faiss";
import { OpenAIEmbeddings } from "langchain/embeddings/openai";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";

const loader = new GithubRepoLoader(
  "https://github.com/langchain-ai/langchainjs/tree/main/examples/src/",
  {
    recursive: true,
    unknown: "warn",
    maxConcurrency: 5, // Defaults to 2
  }
);
const docs = await loader.load();
console.log({ docs });

const textSplitter = RecursiveCharacterTextSplitter.fromLanguage("js", {
  chunkSize: 4096,
  chunkOverlap: 0,
});

const splitDocs = await textSplitter.splitDocuments(docs);

const vectorstore = await FaissStore.fromDocuments(splitDocs, new OpenAIEmbeddings());

await vectorstore.save("./data/");
