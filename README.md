# VoxScribe

VoxScribe is a powerful Raycast extension that transforms spoken words into written text with ease. It bridges the gap between audio and text, allowing you to quickly convert voice recordings or podcasts into editable transcripts.

## Features

- Transcribe audio files to text using Deepgram's advanced AI models.
- Automatic language detection for multilingual support.
- Smart formatting for polished, readable transcripts.
- Audio chunking and compression for efficient processing of large files.
- Transcription history management with easy access and removal.
- Detailed metadata display (e.g., detected language, model info, file size).

## Installation

1. Ensure you have [Raycast](https://www.raycast.com/) installed on macOS.
2. Install the VoxScribe extension from the Raycast Store.

## Configuration

Before using VoxScribe, set up your Deepgram API key and FFmpeg.

### Deepgram API Key

1. Sign up for a [Deepgram account](https://deepgram.com/) and obtain an API key.
2. In Raycast, go to VoxScribe extension settings.
3. Enter your API key in the "Deepgram API Key" field.

### FFmpeg

- **macOS:** Install via Homebrew:
  ```
  brew install ffmpeg
  ```
- **Windows:** Download from [FFmpeg's official website](https://ffmpeg.org/download.html) and add to your PATH.

Ensure FFmpeg is in your system's PATH for audio processing.

## Usage

1. Open Raycast and search for "Transcribe".
2. Select "Transcribe New Audio", choose a file, and wait for results.
3. View results with transcription text, metadata, and copy/export options.

## Transcription History

Access and manage recent transcriptions from the main interface:

- View, copy, or remove entries.
- History is limited to the last 10 items for efficiency.

## Contributing

Contributions are welcome! Follow these steps:

1. Fork the repository.
2. Create a feature/bugfix branch.
3. Commit changes with clear messages.
4. Push to your fork and submit a pull request.

## License

VoxScribe is released under the MIT License. See the LICENSE file for details.

## Support

Encounter issues? File a GitHub issue or contact via Raycast support channels.

## Roadmap

Here are planned features to enhance VoxScribe. Priorities are based on user impact and implementation complexity. Contributions welcome!

  - **High Priority:**
    - Batch Processing for Multiple Files: Transcribe entire folders or queues of audio files at once.

- **Medium Priority:**
  - Advanced Export and Sharing Options: Support PDF/Markdown exports and integrations with apps like Notion or Evernote.
  - Search and Filtering in History: Add search bars, date/language filters, and sorting for easier navigation.

- **Low Priority:**
  - More Robust Error Handling and User Guidance: Include retries, progress percentages, and tips for optimal audio quality.
  - Customization and Advanced AI Features: Add custom vocabulary, sentiment analysis, and integrations like AI summaries.
