# Content Generation Worker

A Node.js/TypeScript application that processes JSON files to generate multimedia content using the [fal.ai](https://fal.ai) API.

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd content-generation-worker
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the application:
   ```bash
   npm run build
   ```
   
4. Install 
   ```bash
   brew install ffmpeg
   ```

## Configuration

The application uses the `dotenv` library to automatically load environment variables from a `.env` file.

### Required Environment Variables

- `FAL_KEY`: Your fal.ai API key for image generation

### Optional Environment Variables

- `MOCK_API`: Set to `'true'` to run in mock mode without making actual API calls
- `DEBUG`: Set to `'true'` to enable debug logging
- `GENERATIONS_DIR_PATH`: **Absolute path** to the generations directory (overrides relative)
- `GENERATIONS_DIR_RELATIVE_PATH`: **Relative path** from the project root to the generations directory (used if absolute is not set)

#### Generations Directory Configuration

You can control where the generations folder is located:

- **Option 1: Absolute path**
  ```env
  GENERATIONS_DIR_PATH=/absolute/path/to/generations
  ```
- **Option 2: Relative path from the project root**
  ```env
  GENERATIONS_DIR_RELATIVE_PATH=../generations
  ```
- If neither is set, the default is `generations` inside the project root.

### Option 1: Set in Shell

```bash
export FAL_KEY="your-fal-ai-api-key"
export MOCK_API="true"     # Optional
export DEBUG="true"        # Optional
export GENERATIONS_DIR_PATH="/absolute/path/to/generations" # Optional
```

### Option 2: Use `.env` File (Recommended)

Create a `.env` file in the root directory of the project:

```env
FAL_KEY=your-fal-ai-api-key
MOCK_API=true
DEBUG=true
# GENERATIONS_DIR_PATH=/absolute/path/to/generations
# GENERATIONS_DIR_RELATIVE_PATH=../generations
```

> ✅ This method is recommended for local development as it keeps your API key out of your shell history.

## Usage

1. Place your JSON files in the `generations/unprocessed/` directory (or your configured directory).
2. Run the application:
   ```bash
   npm start
   ```
3. The app will process the files and:
   - Move them to the `generations/in-progress/` directory
   - Save generated content in the same folder as the original JSON

## JSON File Format

Each JSON file should follow this structure:

```json
{
  "script": {
    "introduction": "Introduction text",
    "finale": "Finale text",
    "scenes": [
      {
        "title": "Scene Title",
        "description": "Scene Description",
        "narration": "Scene Narration"
      }
    ]
  },
  "character": {
    "character_type": "Character Type",
    "name": "Character Name",
    "appearance": "Character Appearance",
    "personality": "Character Personality",
    "gestures": "Character Gestures",
    "outfit": "Character Outfit",
    "background": "Character Background"
  },
  "enhancedMedia": [
    {
      "scene": 0,
      "scene_type": "introduction",
      "image_prompt": "Image prompt for scene 0",
      "video_prompt": "Video prompt for scene 0"
    }
  ],
  "music": "Music description",
  "titleDesc": "Title description",
  "hashtags": "Hashtags"
}
```

---

## License

MIT