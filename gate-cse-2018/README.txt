GATE CSE 2018: 65 questions, 100 marks; 41 MCQ and 24 NAT.

Launch ../start-quiz.command (macOS) or ../start-quiz.cmd (Windows), then open http://127.0.0.1:8765/gate-cse-2018/ in the same browser/profile each time. Node.js is required. No npm packages or internet connection are needed. Direct file:// opening is unsupported.

Unfinished responses and Mark for review flags cache automatically in the browser. Clearing browser data or ending a private session can erase them. If caching fails, keep the tab open. Clear response preserves its flag; Clear answers and fresh Attempt again clear flags. Flags do not affect scoring.

Submit shows each response, outcome, correct answer, and marks, and saves the latest attempt.json. A successful save clears the draft/flags; invalid numerical input or a failed save preserves them. Review last attempt is enabled only when a readable saved file has a non-null answer. Review regrades saved responses without replacing the current draft; Back to quiz restores the previous view. Attempt again starts fresh practice and preserves the saved submission. Save report and Print report are available.

After Submit and in Review last attempt, the map uses green for Correct, red for Incorrect, and neutral for Unanswered. Linked answers that cannot be evaluated are amber; marks-to-all awards are blue. Marked questions show ★ instead of the usual status symbol, keeping their outcome color.

Submit saves review flags in attempt.json without changing scoring. A successful save clears draft/practice flags while keeping report stars; a failed save keeps the draft, flags, and report. Saved Review uses the submitted flags; Back to quiz restores the prior draft/view and its flags. Older submissions remain readable but cannot recover past review flags.

MCQ wrong answers deduct one-third of their marks; NAT has no negative marking. Unanswered questions score zero. CS-15 accepts 0.021-0.024, CS-16 0.27-0.30, CS-23 59-60, and CS-44 0.60-0.62, all inclusive. Remaining NAT keys are exact values. No alternate MCQ keys or marks-to-all entries. Blank: 0/100; perfect: 100/100; all wrong: -21/100.

The supplied GATE2018.pdf (23 physical pages) and Keys2018.pdf (3 pages) remain unchanged in /Users/icode100/Downloads. They are not duplicated here. Filenames and SHA-256 hashes are recorded in quiz-data.js and the independent key fixture. All quiz resources are local; originals are not needed to run it. GA 1-10 and CS 1-55 retain separate numbering. GA headers say Set-3; no session number is inferred.

Includes 65 lossless PNG crops at 240 DPI, with full-resolution image links, source pages, and PDF-point rectangles. Every source page and final crop was visually checked. The CS-38 parse-tree diagram retains the inherent raster softness of the supplied source.

Marking reference: IIT Guwahati's GATE 2018 Information Brochure, section 5.2.1, mirrored at https://acetheraceonline.com/wp-content/uploads/2017/11/GATE-2018-Information-Brochure.pdf (search-index verified; direct fetch unavailable during preparation).

Home: Unsolved only filters papers. Reset saved attempts removes saved submissions after confirmation, leaving unfinished browser drafts and theme intact. Never use reset for development tests.

Verification: node tests/quiz-2018.test.cjs checks an independently transcribed 65-entry key, all 164 MCQ choices, numerical boundaries, scores, assets/provenance, draft/flag/review lifecycle, and temporary-server scores. No real attempt is created during testing.

Timer: choose 180, 150, 120, 90, 60, or 30 minutes (default 180), then Start, Pause, or Reset. No custom duration is available. Changing the preset or Reset leaves it paused. It restores with the browser draft; a running timer counts elapsed time while closed. At zero it stops with a message and you can keep answering. Submit resets it even for invalid input or a failed save; Clear answers preserves it. Reviewing hides the timer while a running timer keeps counting; Back to quiz shows it again. It never enters attempt.json and is hidden in reports and print.

Theme: remembered blue accents in light/dark mode; the dark page remains pitch black and the light page keeps its existing background.
Current practice scoring: Out of syllabus beside Clear response and Mark for review manually excludes a question from earned and maximum marks, including marks-to-all awards. Responses and review flags remain. If a linked prerequisite is excluded, its included dependent is graded independently with the original penalty. Percentage takes priority in reports, Save/Print, and home cards/bars; earned/eligible marks remain visible. Original weights and negative penalties apply. If all questions are excluded, percentage is unavailable with 0/0 marks. Paper totals and score examples above assume no exclusions.

Exclusions restore with the browser draft and are saved with Submit. Clear response keeps them; Clear answers and fresh Attempt again clear them. A successful save clears practice exclusions/draft while keeping the report snapshot; invalid input or a failed save preserves them. Saved Review uses its saved exclusions; Back to quiz restores practice. Older submissions without exclusions include every question.

Practice navigation also caches the last viewed question, including MCQ auto-advance and map jumps. Refresh/reopen resumes there, even without answers; older drafts start at the first question. Report navigation never changes it. Clear answers and fresh Attempt again return to the first question.

Rough work: click the pen icon for a per-question drawing notebook with Pen, Highlighter, Eraser, colors, widths, Undo/Redo, and undoable Clear page. Blank, Dotted, Ruled or Grid paper is remembered per question; Clear page keeps the paper style. Completed strokes save in this browser separately from answers and scoring and restore after reopening; Submit, Clear answers, Attempt again and Review do not remove notes. Question map, the pen button, or Escape from the panel closes it; small screens show it below the test. White drawing paper keeps ink readable in both themes. Browser-data removal can erase notes; if saving fails, keep the tab open. External screen annotations are not captured.
