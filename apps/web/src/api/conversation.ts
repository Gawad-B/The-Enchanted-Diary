import { ConversationSchema, type Conversation } from '@enchanted/shared';
import { fetchApi, getJson, readApiError } from './client';

/** `GET /api/documents/:id/conversation`: the questions and answers of this manuscript, oldest first. */
export function getConversation(documentId: string, signal?: AbortSignal): Promise<Conversation> {
  return getJson(
    `/api/documents/${encodeURIComponent(documentId)}/conversation`,
    ConversationSchema,
    signal ? { signal } : {},
  );
}

/** `DELETE /api/documents/:id/conversation`: the diary forgets the conversation (the manuscript stays). */
export async function deleteConversation(documentId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetchApi(`/api/documents/${encodeURIComponent(documentId)}/conversation`, {
    method: 'DELETE',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw await readApiError(response);
}
