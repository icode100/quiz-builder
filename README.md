# quiz-builder

Local GATE CSE practice quizzes with black and light themes, magenta accents, and original PDF question images.

Double-click [start-quiz.cmd](start-quiz.cmd) to start/reuse the small local server and open the quiz list in your default browser. Node.js must be available; no npm packages or internet connection are needed.

For PowerShell terminal commands, create your profile if missing and open it:

```powershell
if (!(Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
notepad $PROFILE
```

Add these functions, save, and reload with `. $PROFILE`:

```powershell
function quiz-start { powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\ipsdas\Documents\ChatGPT\Quiz\start-quiz.ps1' -NoBrowser }
function quiz-stop  { powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\ipsdas\Documents\ChatGPT\Quiz\stop-quiz.ps1' }
```

`quiz-start` runs without opening a browser; `quiz-stop` stops only this workspace's server owned by your user. The draft cache and submitted files remain intact.

Unfinished answers cache automatically in your browser and restore after reopening. Always use the same browser/profile and `http://127.0.0.1:8765`; opening HTML files directly uses a different, unreliable storage origin. Clearing browser data or ending a private session can erase drafts.

If caching fails, keep the tab open. Attempt again remains usable and keeps the failure warning visible.

Submit displays your score and question-by-question report and saves the latest submission to that quiz's `attempt.json`. The draft clears only after saving succeeds. **Review last attempt** opens that saved report without changing current practice; **Back to quiz** returns to your prior view. **Attempt again** starts fresh practice while preserving the saved submission. Save report and Print report remain available.

Available quizzes, after starting the server:

- [GATE CSE 2020, session 6](http://127.0.0.1:8765/gate-cse-2020/index.html)
- [GATE CSE 2021, Set 1, session 5](http://127.0.0.1:8765/gate-cse-2021-set-1/index.html)
- [GATE CSE 2021, Set 2, session 6](http://127.0.0.1:8765/gate-cse-2021-set-2/index.html)

Each has 65 questions and 100 marks. Original PDFs, diagrams, and equations remain in each folder. Builder guidance: `AGENTS.md`.

Git excludes personal `attempt.json` files and temporary renders in `tmp/`; they remain available locally.
