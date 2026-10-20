# quiz-builder

Local GATE CSE practice quizzes with black and light themes, blue accents, and original PDF question images.

Double-click [start-quiz.cmd](start-quiz.cmd) to start/reuse the small local server and open the quiz list in your default browser. Node.js must be available; no npm packages or internet connection are needed.

The home page and quizzes share remembered light/dark mode, blue accents, and soft card shadows. Dark mode uses deeper royal-blue controls on a pitch-black page; the light palette keeps its existing colors and pale background. **Theme** is a keyboard-accessible toggle switch.

Question images follow the theme, including reports: original white paper with dark text in light mode, and CSS-inverted black paper with white text in dark mode. Original PNGs, diagrams, and equations stay intact. Click an image to open its original colors at full resolution; printed reports use those original white-paper colors. New quizzes inherit the same styling from `_template`.

Click **Calculator** at the bottom right of the quiz or home page to open the shared scientific calculator. It supports editable expressions, parentheses, powers, roots, logarithms, trigonometry with **DEG/RAD**, factorials, combinations/permutations, **Ans**, and memory controls. Move it by dragging its heading (or focus the heading and use arrow keys), close it with **×** or **Escape**, or use **↗** to open it in a separate tab. Closing and reopening the panel preserves its current calculation; reloading starts fresh. Calculations use JavaScript floating-point arithmetic.

The calculator is available whenever the quiz server runs, also at [http://127.0.0.1:8765/_calculator/](http://127.0.0.1:8765/_calculator/). Its files live once in `_calculator/`; the server adds the launcher to quiz pages, including future quizzes, without copying or changing their files. The calculator itself loads on first opening, uses no extra process or package, follows the page theme, and stays out of printed reports. It never changes quiz responses, timer state, browser drafts, or saved submissions.

The home page lists papers by year, newest first, and automatically places new quizzes in order. Sets within a year stay in natural order (Set 1, Set 2, Set 10). Cards show green **Attempted before** when the latest `attempt.json` has at least one non-null answer, otherwise red **Not attempted**. Attempted cards show the last verified score against that paper's total and a score bar. Scores are recomputed from the saved responses and answer key; stale or invalid submissions show **Last score unavailable**. Negative scores remain visible, with an empty bar.

Turn on the **Unsolved only** switch to hide attempted papers. **Reset saved attempts** asks for confirmation and removes all saved submissions, marking papers unsolved and hiding their scores; unfinished browser drafts remain intact.

On macOS, with Node.js available, run this from the project folder (or double-click `start-quiz.command`) to start/reuse the server without opening a browser:

```bash
bash start-quiz.command
```

Add `--with-browser` to open the quiz list automatically: `bash start-quiz.command --with-browser`. With the existing Mac shell alias, use `quiz-start` for no browser or `quiz-start --with-browser` to open it. The existing `--no-browser` flag is also accepted. Open the list manually at [http://127.0.0.1:8765/](http://127.0.0.1:8765/).

Use `bash stop-quiz.command` (or the Mac `quiz-stop` alias) to stop the recorded server. Copy your existing quiz `attempt.json` files into matching folders on the Mac to retain reports and attempted markers, since Git excludes them. Unfinished browser drafts do not transfer automatically between computers.

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

Practice shows one question at a time, using the paper's original numbers. Choosing an MCQ option saves it and advances; use **Next** or Enter from an answer input for multiple-select and numerical answers. Enter keeps invalid numerical input on its question and never submits. **Previous**, **Next**, and **Skip question** keep your existing responses and review marks. The first and last questions do not wrap, and reaching the end never submits automatically. You can also select any question from the existing map. **Clear response** and **Mark for review** remain beside each question; Submit remains available.

Use **Home** at the top to return to the paper list with your browser draft preserved. Refresh opens the first question with cached answers restored. **Back to quiz** after saved Review restores your prior question; **Clear answers** and a fresh **Attempt again** start at the first question. Reports remain a scrolling question-by-question list.

Each quiz has a countdown with six presets: **180, 150, 120, 90, 60, or 30 minutes** (default 180). Choose a duration, then use **Start**, **Pause**, or **Reset**. Choosing another preset or Reset leaves the timer paused at that duration. It restores with your browser draft, counting elapsed time while closed if it was running. At zero it stops and displays a message; you can keep answering.

Clicking **Submit** resets the timer, including when numerical input is invalid or saving fails. Clear answers preserves it. Reviewing a saved report hides the timer while a running timer keeps counting; Back to quiz shows the remaining time. Timer state never enters saved submissions, and the timer is hidden in reports and print.

**Mark for review** beside **Clear response** toggles a solid blue marker in the practice map. Flags restore with your browser draft and do not affect scoring. Clear response keeps its flag; Clear answers and fresh Attempt again clear flags. Submit keeps a flag snapshot in the report and saves it in `attempt.json`. A successful save clears the draft and practice flags; invalid input or a failed save keeps them. Saved Review uses the submitted flags, and Back to quiz restores your prior draft/view and flags. Older submissions without saved flags remain readable but cannot show past review marks.

After Submit and in **Review last attempt**, the map shows green **Correct**, red **Incorrect**, and neutral **Unanswered** questions. Linked answers that cannot be evaluated appear amber; marks-to-all awards appear blue. Marked questions show **★** instead of the usual status symbol while keeping their outcome color.

The question map highlights the active practice question with an extra blue ring when you navigate, select an MCQ option, or choose a map number. Scrolling does not change the practice question. In reports, the ring follows scrolling, focus, and map jumps. It stays separate from attempted, marked-for-review, and invalid-answer indicators and is announced with `aria-current` for assistive technology.

If caching fails, keep the tab open. Attempt again remains usable and keeps the failure warning visible.

Submit displays your score and question-by-question report and saves the latest submission to that quiz's `attempt.json`. The draft clears only after saving succeeds. **Review last attempt** is enabled only if that file has at least one non-null answer; otherwise its disabled button shows **This paper has not been attempted before.** on hover. Review opens the saved report without changing current practice; **Back to quiz** returns to your prior view. **Attempt again** starts fresh practice while preserving the saved submission. Save report and Print report remain available.

Available quizzes, after starting the server:

- [GATE CSE 2021, Set 1, session 5](http://127.0.0.1:8765/gate-cse-2021-set-1/index.html)
- [GATE CSE 2021, Set 2, session 6](http://127.0.0.1:8765/gate-cse-2021-set-2/index.html)
- [GATE CSE 2020, session 6](http://127.0.0.1:8765/gate-cse-2020/index.html)
- [GATE CSE 2019](http://127.0.0.1:8765/gate-cse-2019/index.html)
- [GATE CSE 2018](http://127.0.0.1:8765/gate-cse-2018/)
- [GATE CSE 2017, Set 1, session 1](http://127.0.0.1:8765/gate-cse-2017-set-1/)
- [GATE CSE 2016, Set 1](http://127.0.0.1:8765/gate-cse-2016-set-1/)
- [GATE CSE 2015, Set 1, 7 February forenoon](http://127.0.0.1:8765/gate-cse-2015-set-1/)
- [GATE CSE 2012, Booklet Code A](http://127.0.0.1:8765/gate-cse-2012/)
- [GATE CSE 2010](http://127.0.0.1:8765/gate-cse-2010/)
- [GATE CSE 2013, Booklet A](http://127.0.0.1:8765/gate-cse-2013/)
- [GATE CSE 2009](http://127.0.0.1:8765/gate-cse-2009/)
- [GATE CSE 2007](http://127.0.0.1:8765/gate-cse-2007/)

The 2007 paper has 85 MCQs totaling 150 marks. The 2009 paper has 60 MCQs totaling 100 marks; the later papers each have 65 questions totaling 100 marks. Original question crops preserve diagrams and equations. New quizzes record source filenames and hashes without duplicating supplied PDFs. Builder guidance: `AGENTS.md`.

The 2007 quiz completes all 36 missing key entries, corrects four supplied answers, and explicitly clarifies Q15's defective loop-count wording. Its 97 original image crops include a restored grammar from the original exam scan. It uses the 2007 penalties (-0.25/-0.5) and five linked pairs, 76/77 through 84/85. The completed key and derivations are in `gate-cse-2007/KEY-NOTES.txt`; checks run with `node tests/quiz-2007.test.cjs`.

The 2009 quiz preserves the supplied paper and screenshot key, with 69 sharp image parts. Its practice key completes eight blanks, corrects Q11/Q13, preserves the supplied alternatives, and documents Q47's ambiguous wording in `gate-cse-2009/KEY-NOTES.txt`. Original-exam scan crops restore missing notation in affected questions. Linked-answer rules apply to 57/58 and 59/60: the second scores only when the first is correct and has no negative marking. Its checks run with `node tests\quiz-2009.test.cjs` and `node tests\quiz-linked.test.cjs`.

The 2012 quiz uses Booklet Code A with 65 MCQs, 100 marks, and printed CS 1–55 then GA 56–65 order. Its six marks-to-all entries award 10 marks even unanswered; linked pairs 52/53 and 54/55 follow the supplied exam directions. All 69 sharp original crops preserve shared contexts as 73 displayed parts. The source PDFs remain unchanged in Downloads, with filenames and hashes recorded in quiz data. Independent checks run with `node tests/quiz-2012.test.cjs`.

The 2019 quiz has 41 MCQ and 24 NAT questions. Its verified key retains the C/D alternative for CS-12 and the two separate numerical ranges for CS-42. Source filenames and printed set labels are preserved; no session number is inferred. Its independent checks run with `node tests\quiz-2019.test.cjs`.

The 2018 quiz has 41 MCQ and 24 NAT questions, with 65 original 240 DPI question crops. It preserves the supplied inclusive ranges for CS-15, CS-16, CS-23, and CS-44. The original PDFs remain in their supplied location; the quiz works entirely from its local crops and verified data. Its independent checks run with `node tests/quiz-2018.test.cjs`.

The 2017 Set 1 quiz has 45 MCQ and 20 NAT questions, totaling 100 marks, from 11 February 2017, session 1. It preserves the source order and numbering: CS 1–55, then GA 56–65. Its 65 original 240 DPI crops retain the supplied images and notation; the two source PDFs remain unchanged in Downloads. CS-45 accepts 86.5–89.5 and CS-50 accepts 1.49–1.52, inclusive; CS-49 is exactly −16. MCQ penalties use the official full-precision one-third rule. Independent key, crop, grading, persistence, and disposable-server checks run with `node tests/quiz-2017-set-1.test.cjs`.

The 2016 Set 1 quiz has 39 MCQ and 26 NAT questions, totaling 100 marks, with 65 original 240 DPI crops. It retains GA 1–10 followed by CS 1–55 and records the printed GA Set-5 / CS Set A labels without inferring a session. CS-8 accepts 3–4, CS-27 accepts 197.9–198.1, CS-29 accepts 0.33–0.34, and CS-32 accepts 33–34, all inclusive. Other NAT keys are exact. Its source PDFs remain unchanged in Downloads. Independent checks run with `node tests/quiz-2016-set-1.test.cjs`.

The 2015 Set 1 quiz uses the supplied combined question/key, preserving GA 1–10 and CS 11–65. The separately supplied paper arranges the same questions differently; its order is not used for answer mapping. There are 45 MCQ, 20 NAT and 65 original crops, without answer annotations or coloured key lists. CS-39 accepts 0.40–0.46 inclusive; other numerical keys are exact. Originals stay unchanged outside the quiz folder. Independent checks run with `node tests/quiz-2015-set-1.test.cjs`.

The 2014 Set 1 quiz is available at [http://127.0.0.1:8765/gate-cse-2014-set-1/](http://127.0.0.1:8765/gate-cse-2014-set-1/). It contains 65 questions, 100 marks, 40 MCQs and 25 NATs in printed GA 1–10 / CS 1–55 order. The key identifies Session 7; printed headers say GA Set-7 and CS Set-1. The separate GATE 2014 watermark objects were removed before making the 65 sharp question crops; question content and supplied originals are unchanged. Marking follows page 4 of the supplied paper. Independent checks run with `node tests/quiz-2014-set-1.test.cjs`.

The [2010 quiz](http://127.0.0.1:8765/gate-cse-2010/) has 65 MCQs, 100 marks and two linked pairs, 52/53 and 54/55. Its supplied screenshot key needed seven corrections, two completed blanks and a resolved duplicate Q60; `gate-cse-2010/KEY-NOTES.txt` records the full reconciled practice key and derivations. Six original-exam crops restore defective reproduced questions, including Q65's missing third digit 3. All source files remain unchanged outside the quiz folder. Independent checks: `node tests/quiz-2010.test.cjs`.

The 2013 Booklet A quiz has 65 MCQs and 100 marks, retaining CS 1–55 then GA 56–65 and using only ORS key column A. CS-42/47 receive marks to all; linked pairs 52/53 and 54/55 follow the cover's dependent grading and zero dependent penalty. Its 69 original PNG crops repeat shared context on every relevant slide. Blank scores 4/100; perfect scores 100/100. Supplied PDFs remain unchanged outside the folder, with hashes and crop provenance in data. Independent checks run with `node tests/quiz-2013.test.cjs`.

Git excludes personal `attempt.json` files and temporary renders in `tmp/`; they remain available locally.

Timer and shared-interface checks: `node tests/quiz-timer.test.cjs` and `node tests/quiz-runtime.test.cjs`; tests use simulated storage or temporary folders.

Report-map and saved-review-flag checks: `node tests/quiz-report-map.test.cjs`. Current-question map checks: `node tests/quiz-current-question.test.cjs`.

Calculator checks: `node tests/calculator-engine.test.cjs`, `node tests/calculator-ui.test.cjs`, `node tests/calculator-launcher.test.cjs`, and `node tests/quiz-calculator.test.cjs`; the HTTP tests use disposable quiz folders.
