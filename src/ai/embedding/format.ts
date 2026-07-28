export function formatMessageSearchText(
  content: string | null | undefined,
  replyContent?: string | null,
): string {
  const message = content?.trim() || '';
  const reply = replyContent?.trim();
  return reply ? `Q: ${reply}\n\nA: ${message}` : message;
}
