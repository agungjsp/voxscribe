import {
  Action,
  ActionPanel,
  Alert,
  confirmAlert,
  Detail,
  Form,
  Icon,
  List,
  showToast,
  Toast,
  useNavigation,
  openExtensionPreferences,
  getPreferenceValues,
} from "@raycast/api";
import path from "path";
import { useEffect, useState, useRef, useCallback } from "react";

import {
  getTranscriptionHistory,
  removeTranscriptionItem,
  saveTranscription,
  TranscriptionHistoryItem,
} from "./storage";
import { transcribeAudio } from "./transcribe";
import { formatDuration, formatFileSize, AudioMetadata } from "./audioUtils";

interface TranscriptionProgressViewProps {
  filePath: string;
  onComplete: (result: {
    transcription: string;
    rawData: string;
    chunkedFileInfo: {
      size: number;
      extension: string;
    };
    audioMetadata?: AudioMetadata;
    originalFileInfo?: {
      size: number;
      format: string;
      isValidAudio: boolean;
    };
  }) => void;
  onCancel: () => void;
}

function TranscriptionProgressView({ filePath, onComplete, onCancel }: TranscriptionProgressViewProps) {
  const [stage, setStage] = useState("validation");
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(4);
  const [message, setMessage] = useState("Starting...");
  const [isCompleted, setIsCompleted] = useState(false);
  const abortController = useRef(new AbortController());
  const isRunning = useRef(false);

  const memoizedOnComplete = useCallback(onComplete, []);

  useEffect(() => {
    const runTranscription = async () => {
      if (isRunning.current) return;
      isRunning.current = true;

      try {
        const progressCallback = (newStage: string, newProgress: number, newTotal: number, newMessage: string) => {
          setStage(newStage);
          setProgress(newProgress);
          setTotal(newTotal);
          setMessage(newMessage);
        };

        const result = await transcribeAudio(filePath, abortController.current.signal, progressCallback);

        await saveTranscription({
          filePath,
          transcription: result.transcription,
          rawData: result.rawData,
          compressedFileInfo: result.chunkedFileInfo,
          timestamp: Date.now(),
          audioMetadata: result.audioMetadata,
          originalFileInfo: result.originalFileInfo,
        });

        setIsCompleted(true);
        memoizedOnComplete(result);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        showToast({ style: Toast.Style.Failure, title: "Transcription failed", message: String(error) });
      } finally {
        isRunning.current = false;
      }
    };

    runTranscription();
  }, [filePath, memoizedOnComplete]);

  const progressPercentage = total > 0 ? Math.round((progress / total) * 100) : 0;

  const getStageEmoji = (currentStage: string) => {
    switch (currentStage) {
      case "validation":
        return "🔍";
      case "preparation":
        return "⚙️";
      case "chunking":
        return "✂️";
      case "transcription":
        return "🎙️";
      default:
        return "⏳";
    }
  };

  const markdown = `
# ${getStageEmoji(stage)} Transcribing Audio

**Progress:** ${progressPercentage}%

**Status:** ${message}

**File:** \`${path.basename(filePath)}\`

---

Press **Cmd + .** to cancel
  `;

  const handleCancel = () => {
    abortController.current.abort();
    onCancel();
  };

  return (
    <Detail
      isLoading={!isCompleted}
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action
            title="Cancel"
            icon={Icon.XMarkCircle}
            onAction={handleCancel}
            shortcut={{ modifiers: ["cmd"], key: "." }}
          />
        </ActionPanel>
      }
    />
  );
}

export default function Command() {
  const [isLoading, setIsLoading] = useState(false);
  const [history, setHistory] = useState<TranscriptionHistoryItem[]>([]);
  const { push } = useNavigation();

  const preferences = getPreferenceValues<{
    autoOpenTranscription?: boolean;
  }>();

  useEffect(() => {
    loadHistory();
  }, []);

  async function loadHistory() {
    const loadedHistory = await getTranscriptionHistory();
    setHistory(loadedHistory);
  }

  async function handleSubmit(values: { audioFile: string[] }) {
    if (values.audioFile.length === 0) {
      await showToast({ style: Toast.Style.Failure, title: "No file selected" });
      return;
    }

    setIsLoading(true);

    try {
      const filePath = values.audioFile[0];
      const fileName = path.basename(filePath);
      const existingTranscription = history.find((item) => path.basename(item.filePath) === fileName);

      if (existingTranscription) {
        const shouldReTranscribe = await confirmAlert({
          title: "File Already Transcribed",
          message: "Do you want to re-transcribe this file?",
          primaryAction: {
            title: "Re-transcribe",
            style: Alert.ActionStyle.Default,
          },
          dismissAction: {
            title: "Use Existing",
            style: Alert.ActionStyle.Cancel,
          },
        });

        if (!shouldReTranscribe) {
          if (preferences.autoOpenTranscription !== false) {
            push(
              <TranscriptionResult
                transcription={existingTranscription.transcription}
                rawData={existingTranscription.rawData}
                chunkedFileInfo={existingTranscription.compressedFileInfo}
                audioMetadata={existingTranscription.audioMetadata}
                originalFileInfo={existingTranscription.originalFileInfo}
              />,
            );
          }
          setIsLoading(false);
          return;
        }
      }

      push(
        <TranscriptionProgressView
          filePath={filePath}
          onComplete={(result) => {
            if (preferences.autoOpenTranscription !== false) {
              push(
                <TranscriptionResult
                  transcription={result.transcription}
                  rawData={result.rawData}
                  chunkedFileInfo={result.chunkedFileInfo}
                  audioMetadata={result.audioMetadata}
                  originalFileInfo={result.originalFileInfo}
                />,
              );
            }
            loadHistory();
            showToast({ style: Toast.Style.Success, title: "Transcription complete" });
          }}
          onCancel={() => {
            showToast({ style: Toast.Style.Failure, title: "Cancelled" });
          }}
        />,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("FFmpeg not found")) {
        push(
          <Detail
            markdown={`
# FFmpeg Required

VoxScribe requires FFmpeg to process audio files.

## Installation

\`\`\`bash
brew install ffmpeg
\`\`\`

After installing, restart Raycast and try again.
            `}
          />,
        );
      } else {
        await showToast({ style: Toast.Style.Failure, title: "Error", message: String(error) });
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRemoveItem(item: TranscriptionHistoryItem) {
    try {
      await removeTranscriptionItem(item);
      await loadHistory();
      await showToast({ style: Toast.Style.Success, title: "Removed" });
    } catch (error) {
      await showToast({ style: Toast.Style.Failure, title: "Failed to remove", message: String(error) });
    }
  }

  async function handleClearHistory() {
    const confirmed = await confirmAlert({
      title: "Clear History",
      message: "Are you sure you want to clear all transcription history?",
      primaryAction: {
        title: "Clear",
        style: Alert.ActionStyle.Destructive,
      },
    });

    if (confirmed) {
      const { clearTranscriptionHistory } = await import("./storage");
      await clearTranscriptionHistory();
      await loadHistory();
      await showToast({ style: Toast.Style.Success, title: "History cleared" });
    }
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search transcription history...">
      <List.Section title="Actions">
        <List.Item
          icon={Icon.Plus}
          title="New Transcription"
          subtitle="Select an audio file to transcribe"
          actions={
            <ActionPanel>
              <Action.Push
                title="New Transcription"
                icon={Icon.Plus}
                shortcut={{ modifiers: ["cmd"], key: "n" }}
                target={
                  <Form
                    actions={
                      <ActionPanel>
                        <Action.SubmitForm title="Transcribe" icon={Icon.MicrophoneFilled} onSubmit={handleSubmit} />
                        <Action title="Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
                      </ActionPanel>
                    }
                  >
                    <Form.FilePicker
                      id="audioFile"
                      title="Audio File"
                      allowMultipleSelection={false}
                      canChooseDirectories={false}
                      allowedFileTypes={[
                        "mp3",
                        "wav",
                        "flac",
                        "aac",
                        "ogg",
                        "opus",
                        "m4a",
                        "wma",
                        "aiff",
                        "webm",
                        "mp4",
                        "mkv",
                        "avi",
                        "mov",
                      ]}
                    />
                  </Form>
                }
              />
              <Action title="Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
            </ActionPanel>
          }
        />
      </List.Section>

      {history.length > 0 ? (
        <List.Section title="History" subtitle={`${history.length} item${history.length !== 1 ? "s" : ""}`}>
          {history.map((item, index) => (
            <List.Item
              key={`${item.filePath}-${item.timestamp}`}
              icon={Icon.Document}
              title={path.basename(item.filePath)}
              subtitle={item.audioMetadata ? formatDuration(item.audioMetadata.duration) : undefined}
              accessories={[
                {
                  text: new Date(item.timestamp).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                },
              ]}
              actions={
                <ActionPanel>
                  <ActionPanel.Section>
                    <Action.Push
                      title="View"
                      icon={Icon.Eye}
                      target={
                        <TranscriptionResult
                          transcription={item.transcription}
                          rawData={item.rawData}
                          chunkedFileInfo={item.compressedFileInfo}
                          audioMetadata={item.audioMetadata}
                          originalFileInfo={item.originalFileInfo}
                        />
                      }
                    />
                    <Action.CopyToClipboard
                      title="Copy Transcription"
                      content={item.transcription}
                      shortcut={{ modifiers: ["cmd"], key: "c" }}
                    />
                  </ActionPanel.Section>
                  <ActionPanel.Section>
                    <Action
                      title="Remove"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      onAction={() => handleRemoveItem(item)}
                      shortcut={{ modifiers: ["cmd"], key: "backspace" }}
                    />
                    {index === 0 && history.length > 1 && (
                      <Action
                        title="Clear All History"
                        icon={Icon.Trash}
                        style={Action.Style.Destructive}
                        onAction={handleClearHistory}
                        shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }}
                      />
                    )}
                  </ActionPanel.Section>
                  <ActionPanel.Section>
                    <Action title="Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : (
        <List.EmptyView
          icon={Icon.MicrophoneFilled}
          title="No Transcriptions Yet"
          description="Press Enter to transcribe your first audio file"
        />
      )}
    </List>
  );
}

interface TranscriptionResultProps {
  transcription: string;
  rawData: string;
  chunkedFileInfo: {
    size: number;
    extension: string;
  };
  audioMetadata?: AudioMetadata;
  originalFileInfo?: {
    size: number;
    format: string;
    isValidAudio: boolean;
  };
}

function TranscriptionResult({
  transcription,
  rawData,
  chunkedFileInfo,
  audioMetadata,
  originalFileInfo,
}: TranscriptionResultProps) {
  const preferences = getPreferenceValues<{
    defaultCopyFormat?: string;
  }>();

  const extractedData = {
    detectedLanguage: "N/A" as string,
    languageConfidence: "N/A" as string,
    modelName: "N/A" as string,
  };

  try {
    const parsedArray = JSON.parse(rawData);
    if (Array.isArray(parsedArray) && parsedArray.length > 0) {
      const firstResult = parsedArray.find((r) => r !== null);
      if (firstResult) {
        const channel = firstResult?.results?.channels?.[0];
        const metadata = firstResult?.metadata;
        const modelKey = metadata?.models?.[0];
        const modelInfo = metadata?.model_info;

        extractedData.detectedLanguage = channel?.detected_language ?? "N/A";
        const confidence = channel?.language_confidence;
        extractedData.languageConfidence = confidence ? `${(confidence * 100).toFixed(1)}%` : "N/A";
        extractedData.modelName = (modelKey && modelInfo?.[modelKey]?.name) ?? "N/A";
      }
    }
  } catch {
    // Ignore parse errors
  }

  const markdown = `## Transcription\n\n${transcription || "*No transcription available*"}`;

  const getCopyContent = (format: string) => {
    if (format === "with-metadata") {
      return `${transcription}\n\n---\nLanguage: ${extractedData.detectedLanguage}\nModel: ${extractedData.modelName}\nDuration: ${audioMetadata ? formatDuration(audioMetadata.duration) : "Unknown"}`;
    }
    if (format === "raw-data") {
      return rawData;
    }
    return transcription;
  };

  const defaultFormat = preferences.defaultCopyFormat || "transcription";

  return (
    <Detail
      markdown={markdown}
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            <Action.CopyToClipboard
              title="Copy Transcription"
              content={getCopyContent(defaultFormat)}
              icon={Icon.Clipboard}
            />
            {defaultFormat !== "transcription" && (
              <Action.CopyToClipboard title="Copy Text Only" content={transcription} icon={Icon.Text} />
            )}
            {defaultFormat !== "with-metadata" && (
              <Action.CopyToClipboard
                title="Copy with Metadata"
                content={getCopyContent("with-metadata")}
                icon={Icon.Document}
                shortcut={{ modifiers: ["cmd"], key: "m" }}
              />
            )}
            <Action.CopyToClipboard
              title="Copy Raw JSON"
              content={rawData}
              icon={Icon.Code}
              shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
            />
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action title="Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
          </ActionPanel.Section>
        </ActionPanel>
      }
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Language" text={extractedData.detectedLanguage} />
          <Detail.Metadata.Label title="Confidence" text={extractedData.languageConfidence} />
          <Detail.Metadata.Label title="Model" text={extractedData.modelName} />
          <Detail.Metadata.Separator />

          {audioMetadata && (
            <>
              <Detail.Metadata.Label title="Duration" text={formatDuration(audioMetadata.duration)} />
              <Detail.Metadata.Label title="Format" text={audioMetadata.format} />
              <Detail.Metadata.TagList title="Quality">
                <Detail.Metadata.TagList.Item
                  text={audioMetadata.isLossless ? "Lossless" : "Lossy"}
                  color={audioMetadata.isLossless ? "#00D26A" : "#FF9500"}
                />
              </Detail.Metadata.TagList>
              <Detail.Metadata.Separator />
            </>
          )}

          {originalFileInfo && <Detail.Metadata.Label title="File Size" text={formatFileSize(originalFileInfo.size)} />}
          <Detail.Metadata.Label title="Processed Size" text={formatFileSize(chunkedFileInfo.size)} />
        </Detail.Metadata>
      }
    />
  );
}
