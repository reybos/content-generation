# Content Generation System

Automated system for generating images and videos from JSON configuration files using AI models.

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file in the project root with your fal.ai API key:

```bash
FAL_KEY=your_api_key_here
```

### Directory Structure

By default, the system uses a `generations/` directory in the project root with the following structure:

```
generations/
├── unprocessed/    # Place JSON files here for processing
├── in-progress/    # Files being processed (automatically managed)
├── processed/      # Successfully processed content
└── failed/         # Failed processing attempts
```

To customize the base directory path, add one of these to your `.env` file:

```bash
# Absolute path
GENERATIONS_DIR_PATH=/absolute/path/to/your/directory

# Or relative path from project root
GENERATIONS_DIR_RELATIVE_PATH=./custom/path
```

## Running

Start the web UI server:

```bash
npm run start
```

The server will start on `http://localhost:3000` (or the port specified in the `PORT` environment variable).

## Usage

1. **Place JSON files** in the `generations/unprocessed/` directory (or your custom path)
2. **Open the web UI** at `http://localhost:3000`
3. **Configure workers** using the web interface:
   - Number of workers
   - Image aspect ratio (9:16 or 16:9)
   - Video model selection
   - Batch size and other parameters
4. **Click "Start Workers"** to begin processing
5. **Processed content** will be available in the `generations/processed/` directory (or your custom path)

The system automatically:
- Detects JSON file format
- Generates images from prompts
- Creates videos from generated images
- Handles errors and retries

## Supported Formats

The system supports multiple JSON formats and automatically detects the format type. Place your JSON files in the `generations/unprocessed/` directory and the system will process them accordingly.

## License

MIT License
