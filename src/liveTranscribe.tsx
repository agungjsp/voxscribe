import { Action, ActionPanel, Detail, showToast, Toast } from "@raycast/api";
import { useState } from "react";
import { saveTranscription, TranscriptionHistoryItem } from "./storage";
import { transcribeLive } from "./transcribe";

export default function LiveTranscribe() {
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcription, setTranscription] = useState("");
  const [rawData, setRawData] = useState("");
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  const handleStart = async () => {
    const controller = new AbortController();
    setAbortController(controller);
    setIsTranscribing(true);
    setTranscription("");
    setRawData("");

    try {
      await showToast({ style: Toast.Style.Animated, title: "Listening..." });

      const result = await transcribeLive((update) => setTranscription(update), controller.signal);

      await saveTranscription({
        filePath: "Live Transcription",
        transcription: result.transcription,
        rawData: result.rawData,
        compressedFileInfo: result.chunkedFileInfo,
        timestamp: Date.now(),
      } as TranscriptionHistoryItem);

      setRawData(result.rawData);
      await showToast({ style: Toast.Style.Success, title: "Transcription complete" });
    } catch (error) {
      await showToast({ style: Toast.Style.Failure, title: "Error", message: String(error) });
    } finally {
      setIsTranscribing(false);
      setAbortController(null);
    }
  };

  const handleStop = () => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
    }
    setIsTranscribing(false);
  };

  const markdown = `
## Live Transcription

${transcription || "Listening for audio... (Speak into your microphone)"}

${isTranscribing ? "\n\n🟢 Recording in progress... Click 'Stop and Save' when finished." : ""}
  `;

  return (
    <Detail
      markdown={markdown}
      isLoading={isTranscribing}
      actions={
        <ActionPanel>
          {!isTranscribing ? (
            <Action
              title="Start Live Transcription"
              onAction={handleStart}
              shortcut={{ modifiers: ["cmd"], key: "l" }}
            />
          ) : (
            <Action title="Stop and Save" onAction={handleStop} shortcut={{ modifiers: ["cmd"], key: "s" }} />
          )}
          {transcription && (
            <Action.CopyToClipboard
              title="Copy Transcription"
              content={transcription}
              shortcut={{ modifiers: ["cmd"], key: "c" }}
            />
          )}
          {rawData && (
            <Action.CopyToClipboard
              title="Copy Raw Data (json)"
              content={rawData}
              shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
            />
          )}
        </ActionPanel>
      }
    />
  );
}
