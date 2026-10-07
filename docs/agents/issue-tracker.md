# Трекер задач: GitHub

Репозиторий: `GitHubFoxy/evercode-fast-track-test-backend`.
Задачи и спецификации публикуем в GitHub Issues через `gh`.

- Создание: `gh issue create`
- Чтение с обсуждением: `gh issue view <number> --comments`
- Список: `gh issue list`
- Комментарий: `gh issue comment <number>`
- Метки: `gh issue edit <number> --add-label / --remove-label`
- Закрытие: `gh issue close <number>`

Запускать команды из папки репозитория: `gh` определяет репозиторий по Git remote. Для команд вне этой папки явно указывать `--repo GitHubFoxy/evercode-fast-track-test-backend`.

«Опубликовать в трекере» означает создать GitHub Issue.
«Прочитать задачу» означает прочитать issue и комментарии.

PRs as a request surface: no.
