ДОКАЗАТЕЛЬНЫЙ ТЕХНИЧЕСКИЙ АУДИТ
1. Текущая реализация проекта
1.1 Регистрация провайдера
Файл: src/extension.ts:156 — vscode.lm.registerLanguageModelChatProvider("llamacpp", llamaProvider)
Контрибуция: package.json:28-32 — contributes.languageModelChatProviders с vendor "llamacpp"
Минимальная версия VS Code: ^1.104.0 (package.json:13)
Proposed API: проект не включает enableProposedApi (проверено grep по package.json)
1.2 Предоставление информации о модели
Файл: src/llama-provider.ts:1429-1490 — mapModelInfo()
Стандартные поля: maxInputTokens, maxOutputTokens, capabilities.toolCalling, capabilities.imageInput
Нестандартные поля: isUserSelectable, multiplierNumeric, model_picker_enabled, configurationSchema (строки 1486-1490)
Расчёт контекста: maxInputTokens = contextLength - maxOutputTokens
1.3 Патч Copilot Chat (v6)
Файл: patch-copilot-chat.mjs
Модифицирует: ExtensionContributedChatEndpoint в минифицированном бандле Copilot
Якоря патча: строки 156-260 — 10 замен (3 точечных + 7 regex)
Тестировался на: VS Code 1.127 / Copilot 0.55 и VS Code 1.129 / Copilot 0.57
2. Исходный код VS Code — ExtensionContributedChatEndpoint
Источник: https://raw.githubusercontent.com/microsoft/vscode/main/extensions/copilot/src/platform/endpoint/vscode-node/extChatEndpoint.ts (main ветка, проверено 2026-07-17)

Ключевые свойства без патча:

Критическое открытие: supportsReasoningEffort не существует в оригинальном коде. Это свойство добавляется исключительно патчем. Без патча Copilot никогда не покажет селектор reasoning effort для сторонних провайдеров.

Критическое открытие: maxOutputTokens всегда возвращает 8192. Значение languageModel.maxOutputTokens из LanguageModelChatInformation полностью игнорируется.

2.1 Обработка usage данных (работает БЕЗ патча)
В том же файле makeChatRequest2:

Вывод: передача usage через LanguageModelDataPart с mimeType usage работает через публичный API. Патч не требуется.

2.2 modelOptions (работает БЕЗ патча, но с ограничением)
В makeChatRequest2:

Вывод: оригинальный код передаёт modelOptions с внутренними полями трассировки. Патч добавляет reasoningEffort через spread. Без патча modelOptions.reasoningEffort не будет установлен, так как UI-селектор не существует.

3. Proposed API — актуальное состояние
3.1 chatProvider (vscode.proposed.chatProvider.d.ts)
Источник: https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.chatProvider.d.ts

Добавляет к LanguageModelChatInformation:

configurationSchema — JSON Schema для per-model конфигурации
isBYOK, isDefault, isUserSelectable, statusIcon, warningText, promo
requiresAuthorization, multiplierNumeric, targetChatSessionType
Добавляет к LanguageModelChatCapabilities:

editTools — предпочтительные инструменты редактирования
Добавляет к ProvideLanguageModelChatResponseOptions:

requestInitiator, modelConfiguration
Проект НЕ включает enableProposedApi → эти поля игнорируются в стабильных сборках.

3.2 languageModelThinkingPart (vscode.proposed.languageModelThinkingPart.d.ts)
Источник: https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.languageModelThinkingPart.d.ts

Добавляет:

LanguageModelThinkingPart — класс для reasoning/thinking контента
Поддержка thinking parts в LanguageModelChatResponse.stream
Проект НЕ включает proposed API → thinking parts недоступны.

4. Таблица подтверждённых возможностей и ограничений
Возможность	Публичный API	Proposed API	Патч Copilot	Собственный Sidebar
Discovery моделей	✅	✅	✅	✅
Передача usage в Session Info	✅	✅	✅	❌
maxOutputTokens > 8192	❌	❌	✅	❌
Селектор reasoning effort в UI	❌	❌	✅	✅ (отдельный)
Thinking parts (LanguageModelThinkingPart)	❌	🔶	❌	❌
configurationSchema	❌	🔶	❌	❌
Полный context window (input + output)	❌	❌	✅	❌
Отключение авто-суммаризации	❌	❌	✅	❌
Пропуск tool token reservation	❌	❌	✅	❌
Стабильность между обновлениями	✅	⚠️	❌	✅
Совместимость с Codespaces	✅	⚠️	❌	✅
Условные обозначения: ✅ работает, ❌ невозможно, 🔶 работает только в Insiders с включённым proposed API, ⚠️ зависит от условий

5. Расхождения с текущим проектом
5.1 configurationSchema — proposed API, но проект не включает enableProposedApi
Файл: src/llama-provider.ts:1490 — info.configurationSchema = createReasoningConfigurationSchema(family)
Файл: reasoning.ts — createReasoningConfigurationSchema() создаёт схему с reasoningEffort enum
Проблема: configurationSchema — это поле из proposed API chatProvider. Без enableProposedApi в package.json VS Code игнорирует это поле в стабильных сборках.
Статус: ❌ Недокументированная проблема. COPILOT_PATCH.md не упоминает, что configurationSchema требует proposed API.
5.2 isUserSelectable и multiplierNumeric — proposed API
Файл: src/llama-provider.ts:1486-1488
Проблема: эти поля определены в vscode.proposed.chatProvider.d.ts. Без proposed API эффект непредсказуем.
Статус: ⚠️ Поля устанавливаются, но без enableProposedApi их влияние неизвестно.
5.3 model_picker_enabled — внутренний флаг
Файл: src/llama-provider.ts:1489 — info.model_picker_enabled = true
Проблема: не найден ни в публичном, ни в proposed API. Это внутренний флаг Copilot.
Статус: ❓ Непроверенное утверждение. Эффект этого флага не документирован.
5.4 CustomDataPartMimeTypes.Usage — внутренний тип
Файл: docs/COPILOT_PATCH.md:25-40 — описание механизма usage
Проблема: CustomDataPartMimeTypes — это внутренний enum Copilot (extensions/copilot/src/platform/endpoint/common/endpointTypes.ts). MIME тип usage не документирован в публичном API.
Статус: ⚠️ Механизм работает (подтверждено по исходному коду extChatEndpoint.ts), но опирается на внутреннюю реализацию. Теоретически может измениться.
5.5 Утверждение "context counter does not require the Copilot patch"
Файл: docs/COPILOT_PATCH.md:17
Статус: ✅ Подтверждено. extChatEndpoint.ts парсит LanguageModelDataPart с mimeType usage без патча.
5.6 Утверждение "Thinking Effort and the provider-specific output limit do [require the patch]"
Файл: docs/COPILOT_PATCH.md:19
Статус: ✅ Подтверждено. supportsReasoningEffort не существует в оригинальном коде. maxOutputTokens фиксирован на 8192.
6. Рекомендуемая архитектура
Гибридный подход: публичный API + опциональный патч + fallback команды

Уровень 1: Базовый (публичный API, без патча)
Model discovery, streaming, tool calling, memory — работают как есть
Usage через LanguageModelDataPart — работает как есть
Статус-бар и sidebar для метрик — работают как есть
Новое: команда палитры Local LLM: Set Reasoning Mode как fallback для reasoning effort (уже частично реализована в model-behavior-commands.ts)
Уровень 2: Опциональный патч (для полных возможностей)
Сохранить патч как опцию
Улучшение: добавить автопроверку совместимости при активации расширения
Улучшение: команда Local LLM: Check Patch Status в Quick Access
Улучшение: предупреждение в Quick Access, если патч не применён или устарел
Уровень 3: Документация
Добавить в COPILOT_PATCH.md:
Явное указание, что configurationSchema — proposed API (chatProvider)
Явное указание, что isUserSelectable и multiplierNumeric — proposed API
Таблицу "что работает без патча"
Предупреждение, что CustomDataPartMimeTypes.Usage — внутренний тип
Предупреждение, что model_picker_enabled — внутренний флаг
Уровень 4: Долгосрочный
Мониторить upstream VS Code на появление supportsReasoningEffort в публичном API
Рассмотреть включение enableProposedApi для chatProvider и languageModelThinkingPart, если это укладывается в политику расширения
7. Утверждения, которые не удалось подтвердить
model_picker_enabled — внутренний флаг Copilot. Не найден в публичном API, proposed API, или в исходниках Copilot как публичное свойство. Его реальное влияние на поведение model picker не подтверждено.
Точная версия VS Code, в которой LanguageModelChatProvider стал стабильным — проект требует 1.104.0, но API мог появиться раньше.
Поведение configurationSchema в стабильных сборках VS Code — проект устанавливает это поле, но не включает proposed API. Фактическое поведение (игнорирование vs работа) не тестировалось.
Влияние isUserSelectable и multiplierNumeric без proposed API — поля устанавливаются, но без enableProposedApi их эффект неизвестен.
Точный MIME тип CustomDataPartMimeTypes.Usage — это внутренний тип Copilot. Строковое значение MIME типа не было извлечено (требуется чтение endpointTypes.ts).
8. Использованные источники
Локальные файлы:

Файл	Назначение
package.json	версии, контрибуции, отсутствие enableProposedApi
extension.ts	регистрация провайдера, статус-бар, sidebar
llama-provider.ts	mapModelInfo(), provideLanguageModelChatInformation()
base-provider.ts	базовый класс, streaming, tool parsing
reasoning.ts	mapping reasoning effort, createReasoningConfigurationSchema()
vscode.d.ts	объявления типов (21207 строк, checked-in VS Code API)
patch-copilot-chat.mjs	патч v6, якоря замен
COPILOT_PATCH.md	документация патча
ARCHITECTURE.md	архитектура проекта
Внешние источники (GitHub microsoft/vscode, main ветка):

Источник	URL	Статус
extChatEndpoint.ts	https://raw.githubusercontent.com/microsoft/vscode/main/extensions/copilot/src/platform/endpoint/vscode-node/extChatEndpoint.ts	✅ Полностью прочитан
vscode.proposed.chatProvider.d.ts	https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.chatProvider.d.ts	✅ Полностью прочитан
vscode.proposed.languageModelThinkingPart.d.ts	https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.languageModelThinkingPart.d.ts	✅ Полностью прочитан
GitHub text search: LanguageModelDataPart usage	microsoft/vscode repo	✅ 10 результатов
GitHub text search: modelMaxPromptTokens maxOutputTokens supportsPrediction	microsoft/vscode repo	✅ 12 результатов
GitHub text search: LanguageModelChatInformation maxInputTokens	microsoft/vscode repo	✅ 10 результатов
9. Краткий итог
Главный вывод: расширение корректно использует публичный API VS Code для model discovery, streaming, tool calling, и передачи usage данных. Однако три ключевые возможности — динамический maxOutputTokens, селектор reasoning effort в UI, и полный context window — недоступны через публичный API и требуют патча внутреннего кода Copilot.

Критическая проблема: проект устанавливает configurationSchema, isUserSelectable, и multiplierNumeric, которые являются proposed API, но не включает enableProposedApi. Эти поля, скорее всего, игнорируются в стабильных сборках VS Code, и этот факт не документирован.

Рекомендация: сохранить текущий гибридный подход (публичный API + опциональный патч), но:

Документировать зависимость от proposed API для configurationSchema
Добавить fallback-команду для reasoning mode без патча
Добавить автопроверку статуса патча при активации
Рассмотреть включение enableProposedApi для chatProvider и languageModelThinkingPart