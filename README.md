# OpenCode External Tools

Плагін для **OpenCode v2.0.22**: клієнт реєструє іменовані tools для конкретної сесії,
отримує виклики через події, виконує їх зовні (OpenWebUI, n8n, Python тощо) та
повертає результат через HTTP API OpenCode. MCP-сервер і форк OpenCode не потрібні.

## Встановлення

Додай запис до `plugins` у **наявному** `opencode.json(c)` проєкту або глобальному
`~/.config/opencode/opencode.json(c)`, не замінюючи інші налаштування:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:VasyaYovbak/opencode-external-tools#v0.1.0",
      "options": { "timeoutMs": 120000 }
    }
  ]
}
```

OpenCode сам завантажує GitHub-пакет і встановлює залежності. Готовий `dist/`
включений у Git, тому клонувати репозиторій, ставити TypeScript чи запускати
`npm run build` користувачу не потрібно. На першому старті дочекайся завершення
фонової установки плагіна. Тег фіксує версію; для строгого pin можна вказати
повний commit hash замість `v0.1.0`.

### Локальна розробка

```sh
git clone https://github.com/VasyaYovbak/opencode-external-tools.git
cd opencode-external-tools
npm ci
npm run build
npm run typecheck
npm test
```

Для локальної розробки заміни `package` на абсолютний шлях до цієї папки.
Після змін у `src/` запускай `npm run build`, потім перезавантаж конфігурацію OpenCode.
Перед новим релізом включай оновлений `dist/` у commit разом із вихідними файлами.
Кореневий `index.js` потрібен завантажувачу локальних директорій v2; він відкриває
зібраний JavaScript у `dist/` без залежності від runtime-завантаження TypeScript.
`timeoutMs` — час очікування зовнішньої відповіді,
за замовчуванням 120 секунд; допустимий діапазон 1–3600000 мс.

## Контракт

RPC ID: `external_tools`. Усі методи викликаються через:

```text
POST /api/rpc/external_tools/{method}
Content-Type: application/json

{"input": ...}
```

Результат HTTP: `{"output": ...}`; `resolve` та `unregister` повертають `{"output": true}`.
Використовуй автентифікацію свого сервера. Для керованого локального service клієнт
може використати `Service.discover()` і `Service.headers()` — дивись приклад.

**Важливо:** RPC виконується у location, де завантажений плагін. Передавай
`location[directory]` у query, або `{ location: { directory } }` другим аргументом
методу TypeScript-клієнта. Вона повинна збігатися з location сесії.

### 1. Зареєструвати tools

Спочатку створи сесію штатним API v2. Потім виклич `register`:

```json
{
  "input": {
    "sessionID": "ses_...",
    "tools": [
      {
        "name": "get_weather",
        "description": "Return current weather for a city",
        "inputSchema": {
          "type": "object",
          "properties": { "city": { "type": "string" } },
          "required": ["city"],
          "additionalProperties": false
        }
      }
    ]
  }
}
```

`register` замінює набір для сесії, а не додає до попереднього. Невалідна реєстрація
залишає попередній набір незмінним. Схеми компілюються до валідаторів Effect до
реєстрації; коренева схема має бути `type: "object"`.
Підтримується підмножина JSON Schema валідатора Effect, не повна специфікація.
Зокрема `pattern`/`patternProperties` відхиляються за замовчуванням Effect через
ризик необмеженого часу виконання regex. Для критичних перевірок додатково
валідуй аргументи у зовнішньому executor; не покладайся на специфічні `format`
чи інші розширення JSON Schema, не підтримані Effect.

Для різних сесій можна використати однакові імена з різними схемами. Модель бачить
передані імена (`get_weather`), а не універсальний wrapper. Внутрішні ID ізольовані;
tools працюють без Code Mode. Не можна дублювати імена або перекривати штатні tools
(зокрема `read`, `execute`). Дочірні сесії не успадковують зовнішній набір.

### 2. Отримати виклик

Підпишись **до** надсилання prompt на подію `rpc.external_tools.requested`:

```ts
import { ExternalTools } from "opencode-external-tools/rpc"

const bridge = client.rpc(ExternalTools)
for await (const event of bridge.events.subscribe("requested")) {
  console.log(event.location, event.data)
}
```

`event.data`:

```json
{
  "sessionID": "ses_...",
  "messageID": "msg_...",
  "callID": "a-unique-bridge-uuid",
  "toolCallID": "provider-tool-call-id",
  "tool": "get_weather",
  "arguments": { "city": "Kyiv" },
  "createdAt": 1790000000000,
  "expiresAt": 1790000120000
}
```

Фільтруй location та `sessionID`: штатна event-підписка містить події з різних
location. `callID` — унікальний ID **моста**, який слід повертати у `resolve`;
`toolCallID` — інформаційний ID виклику моделі, який може повторюватися.

### 3. Повернути результат

Метод `resolve`:

```json
{
  "input": {
    "sessionID": "ses_...",
    "callID": "a-unique-bridge-uuid",
    "result": {
      "output": "Kyiv: sunny, 22°C",
      "title": "Weather",
      "metadata": { "source": "n8n" }
    }
  }
}
```

Або помилку: `{"input":{"sessionID":"ses_...","callID":"...","error":"Service unavailable"}}`.
Передай рівно одне з `result` / `error`. `output` — текст для моделі; для JSON-відповіді
використай `JSON.stringify(...)`. `title` і `metadata` необов'язкові. Повторна,
прострочена або адресована іншій сесії відповідь отримує `not_found`.

### Перепідключення й завершення

- `pending({ sessionID })` → `{ calls: [...] }` — поточні виклики лише цієї сесії.
- `unregister({ sessionID })` — видаляє набір і скасовує pending-виклики сесії.
- Заміна набору не скасовує вже надіслані виклики; їх можна завершити за старим `callID`.
- Зупинка сесії, таймаут і unload плагіна завершують очікування та прибирають pending.

RPC-події **live-only**, без replay. Після перепідключення підпишись знову та отримай
`pending`; також можна періодично опитувати цей метод. Подія і `pending` можуть
містити один виклик: дедуплікуй за `callID` **до виконання побічних ефектів**.

## Приклад клієнта

Після встановлення плагіна в потрібному location:

```sh
OPENCODE_DIRECTORY=/absolute/path/to/project bun run demo
```

Приклад використовує вже запущений локальний service, або явно заданий сервер:

```sh
OPENCODE_URL=http://127.0.0.1:4096 \
OPENCODE_DIRECTORY=/absolute/path/to/project \
OPENCODE_AUTHORIZATION='Bearer ...' bun run demo
```

Авторизацію бери з налаштувань свого сервера, не копіюй токени в конфігурацію
плагіна. Демо повертає **вигадану погоду**, це не погодний сервіс.

## Перевірки

```sh
npm run typecheck
npm test
npm run test:integration
# Той самий тест із завантаженням пакета з GitHub у чистий cache:
OPENCODE_TEST_PLUGIN=github:VasyaYovbak/opencode-external-tools#v0.1.0 npm run test:integration
```

Остання команда потребує встановленого `opencode` v2.0.22. Вона запускає окремий
сервер з ізольованими config/data/db у `/tmp/opencode`, локальну тестову модель
та перевіряє реальний цикл: валідація аргументів → tool → SSE + pending → HTTP
resolve → продовження моделі. Також перевіряються дві сесії з однаковим іменем
і різними схемами, відмова для відповіді іншій сесії та повторної відповіді.
Платні API, основний OpenCode service та його налаштування не використовуються.

## Межі та безпека

- Це міст для **довірених клієнтів одного OpenCode service**, не multi-tenant ACL.
  Клієнт з доступом до service API може керувати зовнішніми tools його сесій.
  Не виставляй сервер без автентифікації; не логуй секрети в аргументах.
- Реєстрація tools означає згоду на передачу їх аргументів зовнішньому виконавцю.
  Плагін не запускає shell чи довільний код з опису: усе виконує твій клієнт.
- `options.permission` використовує публічне ім'я тула для штатного приховування
  повністю заборонених tools. **Плагін не створює permission-запити `ask`**;
  resource-specific перевірки та підтвердження небезпечних операцій повинен
  виконувати зовнішній executor перед побічними ефектами.
- Стан у пам'яті: після перезапуску/reload потрібно повторно зареєструвати набори;
  завершення старих викликів після перезапуску не підтримується.
- Не exactly-once delivery: для платежів, публікації тощо зберігай idempotency key
  `callID` у зовнішній системі. Таймаут OpenCode не зупиняє зовнішню операцію.
- Ліміти: 128 зареєстрованих сесій на location, 64 tools/сесію, 256 pending-викликів.
  Викликай `unregister`, коли сесія більше не потребує tools.
- Перевірений контракт API: OpenCode 2.0.22. Це не плагін для v1.

Джерела: [Plugins](https://opencode.ai/v2/docs/build/plugins),
[RPC](https://opencode.ai/v2/docs/build/plugins/rpc),
[Client](https://opencode.ai/v2/docs/build/client).
