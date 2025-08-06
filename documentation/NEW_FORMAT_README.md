# Новый формат JSON файлов

## Описание

Добавлена поддержка нового формата JSON файлов для обработки контента. Новый формат более простой и структурированный, чем предыдущий.

## Структура нового формата

```json
{
  "global_style": "Общий стиль для всех изображений",
  "prompts": [
    {
      "line": "Текст строки",
      "prompt": "Промпт для генерации изображения"
    }
  ],
  "title": "Заголовок контента",
  "description": "Описание контента",
  "hashtags": "Хештеги"
}
```

### Поля:

- **global_style** (string) - Общий стиль, который будет добавлен ко всем промптам для генерации изображений
- **prompts** (array) - Массив объектов с промптами
  - **line** (string) - Текст строки
  - **prompt** (string) - Промпт для генерации изображения
- **title** (string) - Заголовок контента
- **description** (string) - Описание контента
- **hashtags** (string) - Хештеги

## Логика обработки

1. **Определение формата**: Система автоматически определяет формат файла по структуре
2. **Блокировка**: Файл блокируется для предотвращения обработки другими потоками
3. **Перемещение**: JSON файл перемещается из `unprocessed` в `in-progress`
4. **Генерация изображений**: Для каждого элемента из массива `prompts`:
   - Промпт объединяется с `global_style`
   - Генерируется изображение с названием `scene_0.png`, `scene_1.png` и т.д.
   - Все изображения генерируются параллельно
5. **Завершение**: Папка перемещается из `in-progress` в `processed`

## Пример использования

```json
{
  "global_style": "Sleek 3D animation with a metallic blue, silver, and neon orange color scheme, featuring dramatic side lighting that creates a playful tech atmosphere with high detail on mechanical components.",
  "prompts": [
    {
      "line": "The robot dog says, \"Beep, beep, beep!\"",
      "prompt": "A friendly metallic robot dog with glowing blue eyes and silver-plated ears, sitting alertly with mouth open mid-beep, small orange indicator lights flashing on its collar, backdrop of clean white futuristic laboratory floor with subtle blue circuit patterns, camera angle slightly low to make the dog appear heroic, visible mechanical joints and detailed tech textures"
    },
    {
      "line": "The robot cat says, \"Whirr, whirr, whirr!\"",
      "prompt": "Sleek robot cat with chrome whiskers and segmented metal tail that's gracefully curved, blue LED eyes glowing as internal gears visibly whirr through transparent sections in its silver body, sitting on a floating metallic platform with soft blue ambient lighting from below, neon orange accents on its paws and ears, hovering tech screens blurred in background"
    }
  ],
  "title": "Robot Animals Dance and Beep!",
  "description": "Join our adorable robot animals as they make fun mechanical sounds! 🤖🐶🐱",
  "hashtags": "#RobotAnimals #KidsLearning #RobotSongs"
}
```

## Результат обработки

После обработки в папке `processed` будет создана структура:

```
processed/
└── test-new-format/
    ├── test-new-format.json
    ├── scene_0.png
    ├── scene_1.png
    └── ...
```

## Совместимость

Система поддерживает оба формата:
- **Старый формат**: С полями `script`, `character`, `enhancedMedia` и т.д.
- **Новый формат**: С полями `global_style`, `prompts`, `title`, `description`, `hashtags`

Система автоматически определяет формат и использует соответствующий обработчик.

## Тестирование

Для тестирования нового формата используйте:

```bash
npm run build
node test-new-format.js
```

Это создаст тестовую структуру папок и обработает тестовый файл в режиме mock. 