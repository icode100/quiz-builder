GATE CSE 2009 - local practice quiz

Run start-quiz.cmd from the parent Quiz folder, then open:
http://127.0.0.1:8765/gate-cse-2009/
On macOS run bash start-quiz.command from the parent folder.

60 single-choice questions, 100 marks. Q1-20 carry 1 mark; Q21-60 carry
2 marks. Wrong answers deduct one-third of the question marks except Q58
and Q60, which have no negative marking. Q58 is evaluated only when Q57
is correct; Q60 only when Q59 is correct. A blocked answer earns zero and
the report explains why. Blank earns 0/100; a perfect response earns 100/100.

This is a reconciled PRACTICE key, not an official final key. Eight blank
screenshot entries were completed and Q11/Q13 corrected. Screenshot
alternatives Q37 B/C, Q44 A/B and Q55 A/D remain accepted single choices.
Q47 uses an explicitly documented interpretation of ambiguous wording.
KEY-NOTES.txt explains all key decisions; reading it reveals answers.

Unchanged sources retained here:
- CS-2009.pdf: supplied 13-page GateForum reproduction.
- answer-key-screenshot.png: supplied answer-key image.
- GATE2009-original-exam-reference.pdf: 14-page scan of the original exam,
  hosted at https://media.geeksforgeeks.org/wp-content/cdn-uploads/20211005202818/GATE2009.pdf
  Its first page verifies scoring. It is a paper reference, not a final key.

69 lossless PNG parts preserve complete questions, options, shared data,
code, tables and figures. Final crops use 240 DPI. Q26, Q40, Q49 and
Q53-56 use original-exam scans because the supplied reproduction loses
notation or wording. Q54 includes the referenced recurrence; Q56 includes
primary-key underlines. Source document, page and PDF-point rectangles
are recorded in quiz-data.js. Other questions use the sharper supplied PDF.

Draft responses and Mark for review flags cache automatically in the same
browser/profile at the address above. Refresh restores them. Clear response
keeps its flag; Clear answers and Attempt again clear flags. Theme is remembered
separately. Flags do not affect marks or enter the saved submission.

Submit shows every response, correct answer, outcome and marks. Only Submit
writes the latest attempt.json. A successful save clears the browser draft;
a failed save retains it. Review last attempt reads the saved report without
replacing current practice; Back to quiz restores it. Attempt again preserves
the submitted file. Save report and Print report are available.

Verified with tests/quiz-2009.test.cjs (all 240 choices, source hashes/assets,
scores, map/report and draft/review lifecycle), tests/quiz-linked.test.cjs
(18 linked-pair combinations and temporary-server recomputation), and shared
runtime/2019/Set2/server regressions. All test submissions use memory or
temporary folders. No real attempt.json was created during development.
The actual server was restarted and the quiz/PNG returned successfully.
In-app browser checks verified the desktop, middle and mobile map layouts,
240 option controls, no horizontal overflow and no console errors. Native
browser shutdown/reopen was not automated.

Timer: choose 180, 150, 120, 90, 60, or 30 minutes (default 180), then Start, Pause, or Reset. No custom duration is available. Changing the preset or Reset leaves it paused. It restores with the browser draft; a running timer counts elapsed time while closed. At zero it stops with a message and you can keep answering. Submit resets it even for invalid input or a failed save; Clear answers preserves it. Reviewing hides the timer while a running timer keeps counting; Back to quiz shows it again. It never enters attempt.json and is hidden in reports and print.

Theme: remembered blue accents in light/dark mode; the dark page remains pitch black and the light page keeps its existing background.
