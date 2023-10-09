import { db } from "@/db";
import { openai } from "@/lib/openai";
import { getPineconeClient } from "@/lib/pinecone";
import { SendMessageValidator } from "@/lib/validators/SendMessageValidator";
import { getKindeServerSession } from "@kinde-oss/kinde-auth-nextjs/server";
import { OpenAIEmbeddings } from "langchain/embeddings/openai";
import { PineconeStore } from "langchain/vectorstores/pinecone";
import { NextRequest } from "next/server";

export const POST = async (req: NextRequest) => {
    // Endpoint for asking a question to a file

    const body = await req.json()

    const { getUser } = getKindeServerSession()
    const user = getUser()

    const { id: userId } = user

    if (!userId) return new Response("Unauthorized", { status: 401 })

    const { fileId, message } = SendMessageValidator.parse(body)

    const file = await db.file.findFirst({
        where: {
            id: fileId,
            userId
        }
    })

    if (!file) return new Response("Not Found", { status: 404 })

    await db.message.create({
      data: {
        text: message,
        isUserMessage: true,
        userId,
        fileId
      }
    })

    // 1. Vectorize the message
    const embeddings = new OpenAIEmbeddings({
      openAIApiKey: process.env.OPENAI_API_KEY
    })

    const pinecone = await getPineconeClient()
    const pineconeIndex = pinecone.Index("pdf-chatbot")

    const vectorstore = await PineconeStore.fromExistingIndex(embeddings, { pineconeIndex, namespace: file.id})
    
    const results = await vectorstore.similaritySearch(message, 4)

    const prevMessages = await db.message.findMany({
      where: {
        fileId
      },
      orderBy: {
        createdAt: "asc"
      },
      take: 6
    })

  const formattedPrevMessages = prevMessages.map((message) => ({
    role: message.isUserMessage ? "user" as const : "assistant" as const,
    content: message.text
  }))

  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    temperature: 0,
    stream: true,
    messages: [
      {
        role: 'system',
        content:
          'Use the following pieces of context (or previous conversaton if needed) to answer the users question in markdown format.',
      },
      {
        role: 'user',
        content: `Use the following pieces of context (or previous conversaton if needed) to answer the users question in markdown format. \nIf you don't know the answer, just say that you don't know, don't try to make up an answer.
          
    \n----------------\n
    
    PREVIOUS CONVERSATION:
    ${formattedPrevMessages.map((message) => {
          if (message.role === 'user') return `User: ${message.content}\n`
          return `Assistant: ${message.content}\n`
        })}
    
    \n----------------\n
    
    CONTEXT:
    ${results.map((r) => r.pageContent).join('\n\n')}
    
    USER INPUT: ${message}`,
      },
    ],
    })


}