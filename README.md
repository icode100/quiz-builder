# quiz-builder

Local GATE CSE practice quizzes with black and light themes, blue accents, and original PDF question images.

Double-click [start-quiz.cmd](start-quiz.cmd) to start/reuse the small local server and open the quiz list in your default browser. Node.js must be available; no npm packages or internet connection are needed.

The home page and quizzes share remembered light/dark mode, blue accents, and soft card shadows. Dark mode uses deeper royal-blue controls on a pitch-black page; the light palette keeps its existing colors and pale background. **Theme** is a keyboard-accessible toggle switch.

The home page uses stacked cards: green **Attempted before** when the latest `attempt.json` has at least one non-null answer, otherwise red **Not attempted**. Attempted cards show the last verified score out of 100 and a score bar. Scores are recomputed from the saved responses and answer key; stale or invalid submissions show **Last score unavailable**. Negative scores remain visible, with an empty bar.

Turn on the **Unsolved only** switch to hide attempted papers. **Reset saved attempts** asks for confirmation and removes all saved submissions, marking papers unsolved and hiding their scores; unfinished browser drafts remain intact.

On macOS, with Node.js available, run this from the project folder (or double-click `start-quiz.command`):

```bash
bash start-quiz.command
```

Use `bash stop-quiz.command` to stop the recorded server; `bash start-quiz.command --no-browser` starts it without opening a browser. Copy your existing quiz `attempt.json` files into matching folders on the Mac to retain reports and attempted markers, since Git excludes them. Unfinished browser drafts do not transfer automatically between computers.

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

Each quiz has a countdown with six presets: **180, 150, 120, 90, 60, or 30 minutes** (default 180). Choose a duration, then use **Start**, **Pause**, or **Reset**. Choosing another preset or Reset leaves the timer paused at that duration. It restores with your browser draft, counting elapsed time while closed if it was running. At zero it stops and displays a message; you can keep answering.

Clicking **Submit** resets the timer, including when numerical input is invalid or saving fails. Clear answers preserves it. Reviewing a saved report hides the timer while a running timer keeps counting; Back to quiz shows the remaining time. Timer state never enters saved submissions, and the timer is hidden in reports and print.

**Mark for review** beside **Clear response** toggles a solid blue marker in the question map. Flags restore with your browser draft and never enter `attempt.json` or affect scoring. Clear response keeps its flag; Clear answers and fresh Attempt again clear flags. A successful saved Submit clears the draft and flags; invalid input or a failed save keeps them. Reviewing the saved report hides current flags, and Back to quiz restores them.

If caching fails, keep the tab open. Attempt again remains usable and keeps the failure warning visible.

Submit displays your score and question-by-question report and saves the latest submission to that quiz's `attempt.json`. The draft clears only after saving succeeds. **Review last attempt** is enabled only if that file has at least one non-null answer; otherwise its disabled button shows **This paper has not been attempted before.** on hover. Review opens the saved report without changing current practice; **Back to quiz** returns to your prior view. **Attempt again** starts fresh practice while preserving the saved submission. Save report and Print report remain available.

Available quizzes, after starting the server:

- [GATE CSE 2009](http://127.0.0.1:8765/gate-cse-2009/)
- [GATE CSE 2018](http://127.0.0.1:8765/gate-cse-2018/)
- [GATE CSE 2019](http://127.0.0.1:8765/gate-cse-2019/index.html)
- [GATE CSE 2020, session 6](http://127.0.0.1:8765/gate-cse-2020/index.html)
- [GATE CSE 2021, Set 1, session 5](http://127.0.0.1:8765/gate-cse-2021-set-1/index.html)
- [GATE CSE 2021, Set 2, session 6](http://127.0.0.1:8765/gate-cse-2021-set-2/index.html)

All papers total 100 marks. The 2009 paper has 60 MCQs; the later papers each have 65 questions. Original question crops preserve diagrams and equations. New quizzes record source filenames and hashes without duplicating supplied PDFs. Builder guidance: `AGENTS.md`.

The 2009 quiz preserves the supplied paper and screenshot key, with 69 sharp image parts. Its practice key completes eight blanks, corrects Q11/Q13, preserves the supplied alternatives, and documents Q47's ambiguous wording in `gate-cse-2009/KEY-NOTES.txt`. Original-exam scan crops restore missing notation in affected questions. Linked-answer rules apply to 57/58 and 59/60: the second scores only when the first is correct and has no negative marking. Its checks run with `node tests\quiz-2009.test.cjs` and `node tests\quiz-linked.test.cjs`.

The 2019 quiz has 41 MCQ and 24 NAT questions. Its verified key retains the C/D alternative for CS-12 and the two separate numerical ranges for CS-42. Source filenames and printed set labels are preserved; no session number is inferred. Its independent checks run with `node tests\quiz-2019.test.cjs`.

The 2018 quiz has 41 MCQ and 24 NAT questions, with 65 original 240 DPI question crops. It preserves the supplied inclusive ranges for CS-15, CS-16, CS-23, and CS-44. The original PDFs remain in their supplied location; the quiz works entirely from its local crops and verified data. Its independent checks run with `node tests/quiz-2018.test.cjs`.

Git excludes personal `attempt.json` files and temporary renders in `tmp/`; they remain available locally.

Timer and shared-interface checks: `node tests/quiz-timer.test.cjs` and `node tests/quiz-runtime.test.cjs`; tests use simulated storage or temporary folders.
