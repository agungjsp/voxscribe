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
import { formatDuration, formatBitrate, formatSampleRate, formatFileSize, AudioMetadata } from "./audioUtils";

interface TranscriptionProgressViewProps {
  filePath: string;
  onComplete: (result: {
    transcription: string;
    rawData: string;
    chunkedFileInfo: unknown;
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
  const [message, setMessage] = useState("Starting transcription...");
  const [isCompleted, setIsCompleted] = useState(false);
  const abortController = useRef(new AbortController());
  const isRunning = useRef(false);

  const preferences = getPreferenceValues<{
    showDetailedProgress?: boolean;
  }>();

  const memoizedOnComplete = useCallback(onComplete, []);

  useEffect(() => {
    const runTranscription = async () => {
      if (isRunning.current) {
        console.log("Transcription already running, skipping duplicate");
        return;
      }
      isRunning.current = true;

      try {
        const progressCallback = (newStage: string, newProgress: number, newTotal: number, newMessage: string) => {
          setStage(newStage);
          setProgress(newProgress);
          setTotal(newTotal);
          setMessage(newMessage);
        };

        const result = await transcribeAudio(filePath, abortController.current.signal, progressCallback);

        // Save to history
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

  const getStageIcon = (currentStage: string) => {
    switch (currentStage) {
      case "validation":
        return "🔍";
      case "preparation":
        return "⚙️";
      case "chunking":
        return "✂️";
      case "transcription":
        return "🎙️";
      case "completion":
        return "✅";
      default:
        return "⏳";
    }
  };

  const getStageTitle = (currentStage: string) => {
    switch (currentStage) {
      case "validation":
        return "Validating Files & Settings";
      case "preparation":
        return "Preparing Audio Processing";
      case "chunking":
        return "Chunking Audio File";
      case "transcription":
        return "Transcribing Audio";
      case "completion":
        return "Transcription Complete";
      default:
        return "Processing...";
    }
  };

  const stages = [
    { key: "validation", title: "Validating Files & Settings", icon: "🔍" },
    { key: "preparation", title: "Preparing Audio Processing", icon: "⚙️" },
    { key: "chunking", title: "Chunking Audio File", icon: "✂️" },
    { key: "transcription", title: "Transcribing Audio", icon: "🎙️" },
    { key: "completion", title: "Transcription Complete", icon: "✅" },
  ];

  const currentStageIndex = stages.findIndex((s) => s.key === stage);

  const basicMarkdown = `
# ${getStageIcon(stage)} ${getStageTitle(stage)}

**Progress:** ${progressPercentage}% (${progress}/${total})

**File:** ${path.basename(filePath)}

---

*Press Cmd+. or click Cancel to stop the transcription process.*
  `;

  const detailedMarkdown = `
# ${getStageIcon(stage)} ${getStageTitle(stage)}

**Progress:** ${progressPercentage}% (${progress}/${total})

**Current Status:** ${message}

**File:** ${path.basename(filePath)}

---

## Processing Stages

${stages
  .map((s, index) => {
    const isCompleted = index < currentStageIndex;
    const isCurrent = index === currentStageIndex;
    const isPending = index > currentStageIndex;

    let statusIcon = "⏳";
    if (isCompleted) statusIcon = "✅";
    else if (isCurrent) statusIcon = "🔄";
    else if (isPending) statusIcon = "⏳";

    return `${statusIcon} ${s.icon} ${s.title}`;
  })
  .join("\n")}

---

*Press Cmd+. or click Cancel to stop the transcription process.*
  `;

  const markdown = preferences.showDetailedProgress !== false ? detailedMarkdown : basicMarkdown;

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
          <Action title="Cancel Transcription" onAction={handleCancel} shortcut={{ modifiers: ["cmd"], key: "." }} />
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
          title: "File already transcribed",
          message: "A file with the same name has already been transcribed. Do you want to re-transcribe it?",
          primaryAction: {
            title: "Re-transcribe",
            style: Alert.ActionStyle.Default,
          },
          dismissAction: {
            title: "Use existing",
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
          await showToast({ style: Toast.Style.Success, title: "Loaded existing transcription" });
          setIsLoading(false);
          return;
        }
      }

      // Show progress view
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
            loadHistory(); // Reload history after completion
            showToast({ style: Toast.Style.Success, title: "Transcription complete" });
          }}
          onCancel={() => {
            showToast({ style: Toast.Style.Failure, title: "Transcription cancelled" });
          }}
        />,
      );

      return; // Exit early since TranscriptionProgressView will handle the rest
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      if (error instanceof Error && error.message.includes("FFmpeg not found")) {
        const markdown = `
# FFmpeg Not Found

It seems that FFmpeg is not installed or not available in your system's PATH. 
VoxScribe requires FFmpeg to process audio files.

---

### Installation Guide

You can install FFmpeg using [Homebrew](https://brew.sh) (recommended for macOS):

\`\`\`bash
brew install ffmpeg
\`\`\`

If you have installed FFmpeg but are still seeing this error, please ensure that its location is included in your system's \`$PATH\` environment variable.
        `;
        push(<Detail markdown={markdown} />);
      } else {
        const preferences = getPreferenceValues<{
          notificationLevel?: string;
        }>();

        // Show error notifications unless set to "none"
        if (preferences.notificationLevel !== "none") {
          await showToast({ style: Toast.Style.Failure, title: "Transcription failed", message: String(error) });
        }

        // Show error detail with option to open preferences
        const errorMarkdown = `
# Transcription Failed

**Error:** ${String(error)}

---

This could be due to:
- Invalid API key
- Unsupported audio format
- Network connectivity issues
- Audio file corruption

Try checking your extension preferences or contact support if the issue persists.
        `;

        push(
          <Detail
            markdown={errorMarkdown}
            actions={
              <ActionPanel>
                <Action title="Open Extension Preferences" onAction={openExtensionPreferences} icon={Icon.Gear} />
                <Action.CopyToClipboard title="Copy Error Details" content={String(error)} icon={Icon.Clipboard} />
              </ActionPanel>
            }
          />,
        );
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRemoveItem(item: TranscriptionHistoryItem) {
    try {
      await removeTranscriptionItem(item);
      await loadHistory();
      await showToast({ style: Toast.Style.Success, title: "Item removed from history" });
    } catch (error) {
      await showToast({ style: Toast.Style.Failure, title: "Failed to remove item", message: String(error) });
    }
  }

  return (
    <List isLoading={isLoading}>
      <List.Item
        title="Transcribe New Audio"
        actions={
          <ActionPanel>
            <Action.Push
              title="Transcribe New Audio"
              target={
                <Form
                  actions={
                    <ActionPanel>
                      <Action.SubmitForm title="Transcribe" onSubmit={handleSubmit} />
                      <Action
                        title="Extension Preferences"
                        onAction={openExtensionPreferences}
                        icon={Icon.Gear}
                        shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
                      />
                    </ActionPanel>
                  }
                >
                  <Form.FilePicker id="audioFile" title="Audio File" allowMultipleSelection={false} />
                </Form>
              }
            />
            <Action
              title="Extension Preferences"
              onAction={openExtensionPreferences}
              icon={Icon.Gear}
              shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
            />
          </ActionPanel>
        }
      />
      <List.Section title="Transcription History">
        {history.map((item, index) => (
          <List.Item
            key={index}
            title={path.basename(item.filePath)}
            subtitle={new Date(item.timestamp).toLocaleString()}
            actions={
              <ActionPanel>
                <Action.Push
                  title="View Transcription"
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
                <Action
                  title="Remove from History"
                  onAction={() => handleRemoveItem(item)}
                  shortcut={{ modifiers: ["cmd"], key: "backspace" }}
                />
                <Action
                  title="Extension Preferences"
                  onAction={openExtensionPreferences}
                  icon={Icon.Gear}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
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

  const displayTranscription = transcription;
  let extractedData = {
    detectedLanguage: "N/A",
    languageConfidence: "N/A",
    topics: null,
    modelName: "N/A",
    modelVersion: "N/A",
    modelArch: "N/A",
  };

  console.log(`🔍 Processing rawData for metadata extraction:`, {
    rawDataType: typeof rawData,
    rawDataLength: rawData?.length || 0,
    rawDataPreview: rawData?.substring(0, 100) || "null",
  });

  try {
    const parsedArray = JSON.parse(rawData);
    console.log(`✅ JSON parse successful:`, {
      parsedType: typeof parsedArray,
      isArray: Array.isArray(parsedArray),
      arrayLength: Array.isArray(parsedArray) ? parsedArray.length : "N/A",
      firstElementExists: Array.isArray(parsedArray) && parsedArray.length > 0 ? !!parsedArray[0] : false,
    });

    if (Array.isArray(parsedArray) && parsedArray.length > 0) {
      // Find the first non-null result (in case some chunks failed)
      const firstValidResult = parsedArray.find((result) => result !== null && result !== undefined);

      console.log(`🔎 Searching for valid result:`, {
        totalElements: parsedArray.length,
        nullCount: parsedArray.filter((r) => r === null || r === undefined).length,
        firstValidFound: !!firstValidResult,
        firstValidStructure: firstValidResult ? Object.keys(firstValidResult) : "null",
      });

      if (firstValidResult) {
        const channel = firstValidResult?.results?.channels?.[0];
        const metadata = firstValidResult?.metadata;
        const modelInfo = metadata?.model_info;
        const modelKey = metadata?.models?.[0];

        console.log(`📊 Extracting metadata:`, {
          hasResults: !!firstValidResult.results,
          hasChannels: !!firstValidResult.results?.channels,
          channelCount: firstValidResult.results?.channels?.length || 0,
          hasMetadata: !!metadata,
          hasModelInfo: !!modelInfo,
          modelKey: modelKey || "none",
        });

        extractedData = {
          detectedLanguage: channel?.detected_language ?? "N/A",
          languageConfidence: String(channel?.language_confidence ?? "N/A"),
          topics: channel?.topics ?? null,
          modelName: (modelKey && modelInfo?.[modelKey]?.name) ?? "N/A",
          modelVersion: (modelKey && modelInfo?.[modelKey]?.version) ?? "N/A",
          modelArch: (modelKey && modelInfo?.[modelKey]?.arch) ?? "N/A",
        };

        console.log(`✅ Metadata extracted successfully:`, extractedData);
      } else {
        console.warn("❌ Raw data array contains no valid results. Cannot extract metadata.");
      }
    } else {
      console.warn("❌ Raw data is not an array or is empty. Cannot extract metadata.");
    }
  } catch (error) {
    console.error("❌ Failed to parse or process rawData for metadata:", error);
    console.log("Raw data that failed to parse:", rawData);
  }

  const markdown = `
## Transcription

${displayTranscription}
  `;

  const getCopyContent = (format: string) => {
    switch (format) {
      case "with-metadata":
        return `${displayTranscription}

---
**Audio Properties:**
- Format: ${audioMetadata?.format || "Unknown"}
- Duration: ${audioMetadata ? formatDuration(audioMetadata.duration) : "Unknown"}
- Quality: ${audioMetadata?.isLossless ? "Lossless" : "Lossy"}
- Model: ${extractedData.modelName}
- Language: ${extractedData.detectedLanguage}`;
      case "raw-data":
        return rawData;
      default:
        return displayTranscription;
    }
  };

  const defaultCopyFormat = preferences.defaultCopyFormat || "transcription";
  const primaryCopyContent = getCopyContent(defaultCopyFormat);

  return (
    <Detail
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard
            title={defaultCopyFormat === "transcription" ? "Copy Transcription (default)" : "Copy Transcription"}
            content={primaryCopyContent}
            icon={Icon.Clipboard}
          />
          {defaultCopyFormat !== "transcription" && (
            <Action.CopyToClipboard title="Copy Transcription Only" content={displayTranscription} icon={Icon.Text} />
          )}
          {defaultCopyFormat !== "with-metadata" && (
            <Action.CopyToClipboard
              title="Copy with Metadata"
              content={getCopyContent("with-metadata")}
              icon={Icon.Document}
              shortcut={{ modifiers: ["cmd"], key: "m" }}
            />
          )}
          {defaultCopyFormat !== "raw-data" && (
            <Action.CopyToClipboard
              title="Copy Raw JSON Data"
              content={rawData}
              icon={Icon.Code}
              shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
            />
          )}
          <Action
            title="Open Extension Preferences"
            onAction={openExtensionPreferences}
            icon={Icon.Gear}
            shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
          />
        </ActionPanel>
      }
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Transcription Info" />
          <Detail.Metadata.Label title="Detected Language" text={extractedData.detectedLanguage} />
          <Detail.Metadata.Label title="Language Confidence" text={String(extractedData.languageConfidence)} />
          <Detail.Metadata.Separator />

          <Detail.Metadata.Label title="AI Model Details" />
          <Detail.Metadata.Label title="Model Name" text={extractedData.modelName} />
          <Detail.Metadata.Label title="Model Version" text={extractedData.modelVersion} />
          <Detail.Metadata.Label title="Model Architecture" text={extractedData.modelArch} />
          <Detail.Metadata.Separator />

          {audioMetadata && (
            <>
              <Detail.Metadata.Label title="Audio Properties" />
              <Detail.Metadata.Label title="Format" text={audioMetadata.format} />
              <Detail.Metadata.Label title="Codec" text={audioMetadata.codec} />
              <Detail.Metadata.Label title="Duration" text={formatDuration(audioMetadata.duration)} />
              <Detail.Metadata.Label title="Sample Rate" text={formatSampleRate(audioMetadata.sampleRate)} />
              <Detail.Metadata.Label title="Bitrate" text={formatBitrate(audioMetadata.bitrate)} />
              <Detail.Metadata.Label title="Channels" text={String(audioMetadata.channels)} />
              <Detail.Metadata.TagList title="Quality">
                <Detail.Metadata.TagList.Item
                  text={audioMetadata.isLossless ? "Lossless" : "Lossy"}
                  color={audioMetadata.isLossless ? "#00D26A" : "#FF9500"}
                />
              </Detail.Metadata.TagList>
              <Detail.Metadata.Separator />
            </>
          )}

          <Detail.Metadata.Label title="File Information" />
          {originalFileInfo && (
            <>
              <Detail.Metadata.Label title="Original File Size" text={formatFileSize(originalFileInfo.size)} />
              <Detail.Metadata.Label title="File Format" text={originalFileInfo.format.toUpperCase()} />
            </>
          )}
          <Detail.Metadata.Label title="Processing Output Size" text={formatFileSize(chunkedFileInfo.size)} />
          <Detail.Metadata.Label title="Processing Format" text={chunkedFileInfo.extension.toUpperCase()} />
        </Detail.Metadata>
      }
    />
  );
}
