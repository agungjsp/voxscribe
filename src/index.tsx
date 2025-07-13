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
} from "@raycast/api";
import path from "path";
import { useEffect, useState } from "react";

import {
  getTranscriptionHistory,
  removeTranscriptionItem,
  saveTranscription,
  TranscriptionHistoryItem,
} from "./storage";
import { transcribeAudio } from "./transcribe";

export default function Command() {
  const [isLoading, setIsLoading] = useState(false);
  const [history, setHistory] = useState<TranscriptionHistoryItem[]>([]);
  const { push } = useNavigation();

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
    const abortController = new AbortController();

    try {
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: "Transcription in progress...",
        primaryAction: {
          title: "Cancel",
          onAction: () => {
            abortController.abort();
            toast.hide();
            showToast({ style: Toast.Style.Failure, title: "Transcription cancelled" });
          },
        },
      });

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
          push(
            <TranscriptionResult
              transcription={existingTranscription.transcription}
              rawData={existingTranscription.rawData}
              chunkedFileInfo={existingTranscription.compressedFileInfo}
            />,
          );
          await showToast({ style: Toast.Style.Success, title: "Loaded existing transcription" });
          setIsLoading(false);
          return;
        }
      }

      const { transcription, rawData, chunkedFileInfo } = await transcribeAudio(filePath, abortController.signal);
      await saveTranscription({
        filePath,
        transcription,
        rawData,
        compressedFileInfo: chunkedFileInfo,
        timestamp: Date.now(),
      });
      await loadHistory();
      push(<TranscriptionResult transcription={transcription} rawData={rawData} chunkedFileInfo={chunkedFileInfo} />);
      await showToast({ style: Toast.Style.Success, title: "Transcription complete" });
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
        await showToast({ style: Toast.Style.Failure, title: "Transcription failed", message: String(error) });
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
                    </ActionPanel>
                  }
                >
                  <Form.FilePicker id="audioFile" title="Audio File" allowMultipleSelection={false} />
                </Form>
              }
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
                    />
                  }
                />
                <Action
                  title="Remove from History"
                  onAction={() => handleRemoveItem(item)}
                  shortcut={{ modifiers: ["cmd"], key: "backspace" }}
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
}

function TranscriptionResult({ transcription, rawData, chunkedFileInfo }: TranscriptionResultProps) {
  let displayTranscription = transcription;
  try {
    const raw = JSON.parse(rawData);
    if (raw[0] && raw[0].results.channels[0].alternatives[0].words) {
      displayTranscription = raw
        .map((r: any) =>
          r.results.channels[0].alternatives[0].words
            .map((word: any) => `[Speaker ${word.speaker}] ${word.word}`)
            .join(" "),
        )
        .join("\n\n");
    }
  } catch (e) {
    // It's not a diarized JSON, so we just display the plain text.
  }
  let extractedData = {
    detectedLanguage: "N/A",
    languageConfidence: "N/A",
    topics: null,
    modelName: "N/A",
    modelVersion: "N/A",
    modelArch: "N/A",
  };

  try {
    const parsedArray = JSON.parse(rawData);

    if (Array.isArray(parsedArray) && parsedArray.length > 0) {
      const firstResult = parsedArray[0];

      const channel = firstResult?.results?.channels?.[0];
      const metadata = firstResult?.metadata;
      const modelInfo = metadata?.model_info;
      const modelKey = metadata?.models?.[0];

      extractedData = {
        detectedLanguage: channel?.detected_language ?? "N/A",
        languageConfidence: String(channel?.language_confidence ?? "N/A"),
        topics: channel?.topics ?? null,
        modelName: (modelKey && modelInfo?.[modelKey]?.name) ?? "N/A",
        modelVersion: (modelKey && modelInfo?.[modelKey]?.version) ?? "N/A",
        modelArch: (modelKey && modelInfo?.[modelKey]?.arch) ?? "N/A",
      };
    } else {
      console.warn("Raw data is not an array or is empty. Cannot extract metadata.");
    }
  } catch (error) {
    console.error("Failed to parse or process rawData for metadata:", error);
  }

  const markdown = `
## Transcription

${displayTranscription}
  `;

  return (
    <Detail
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Transcription" content={displayTranscription} icon={Icon.Clipboard} />
          <Action.CopyToClipboard
            title="Copy Raw Data (json)"
            content={rawData}
            icon={Icon.Code}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
        </ActionPanel>
      }
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Detected Language" text={extractedData.detectedLanguage} />
          <Detail.Metadata.Label title="Language Confidence" text={String(extractedData.languageConfidence)} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label title="Model Name" text={extractedData.modelName} />
          <Detail.Metadata.Label title="Model Version" text={extractedData.modelVersion} />
          <Detail.Metadata.Label title="Model Architecture" text={extractedData.modelArch} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label
            title="Audio File Size (Compressed)"
            text={`${(chunkedFileInfo.size / 1024).toFixed(2)} KB`}
          />
          <Detail.Metadata.Label title="Audio Format" text={chunkedFileInfo.extension} />
        </Detail.Metadata>
      }
    />
  );
}
