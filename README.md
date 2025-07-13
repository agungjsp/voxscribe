# VoxScribe

VoxScribe is a powerful Raycast extension that transforms spoken words into written text with ease. This tool bridges the gap between audio and text, allowing users to quickly convert voice recordings, podcasts, or live speech into editable text format.

## Features

- Transcribe audio files to text using Deepgram's advanced AI models
- Automatic language detection
- Smart formatting of transcriptions
- Audio compression for efficient processing
- Transcription history management
- Detailed metadata display for each transcription
- Speaker diarization to identify and label different speakers

## Installation

1. Ensure you have [Raycast](https://www.raycast.com/) installed on your macOS system.
2. Install the VoxScribe extension from the Raycast store.

## Configuration

Before using VoxScribe, you need to set up your Deepgram API key and FFmpeg:

### Deepgram API Key

1. Sign up for a Deepgram account and obtain an API key.
2. Open Raycast and go to the VoxScribe extension settings.
3. Enter your Deepgram API key in the "Deepgram API Key" field.

### FFmpeg (Windows)

1. Download and install FFmpeg from [FFmpeg's official website](https://ffmpeg.org/download.html).
2. Ensure the FFmpeg executable is accessible in your system's PATH.

### FFmpeg (macOS)

1. Install FFmpeg using Homebrew:
   ```sh
   brew install ffmpeg
   ```
2. Ensure the FFmpeg executable is accessible in your system's PATH.

## Usage

1. Open Raycast and search for "VoxScribe" or "Transcribe".
2. Select "Transcribe New Audio" from the list.
3. Choose an audio file when prompted.
4. Wait for the transcription process to complete.
5. View the transcription result, including the text and metadata.

## Transcription History

VoxScribe keeps a history of your recent transcriptions:

- Access previous transcriptions from the main VoxScribe interface.
- View, copy, or remove historical transcriptions as needed.

## Contributing

Contributions to VoxScribe are welcome! Please follow these steps:

1. Fork the repository.
2. Create a new branch for your feature or bug fix.
3. Make your changes and commit them with clear, descriptive messages.
4. Push your changes to your fork.
5. Submit a pull request to the main repository.

## License

VoxScribe is released under the MIT License. See the LICENSE file for details.

## Support

If you encounter any issues or have questions, please file an issue on the GitHub repository or contact the maintainer through Raycast's support channels.
