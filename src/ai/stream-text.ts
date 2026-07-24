export async function collectStreamedText(
  textStream: AsyncIterable<string>,
  finalText: PromiseLike<string>,
  onTextUpdate?: (text: string) => Promise<void> | void,
): Promise<string> {
  let streamedText = '';
  for await (const textDelta of textStream) {
    if (!textDelta) {
      continue;
    }
    streamedText += textDelta;
    await onTextUpdate?.(streamedText);
  }

  return finalText;
}
