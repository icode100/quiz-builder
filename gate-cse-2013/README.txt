GATE CSE 2013 - Booklet A
65 single-choice questions, 100 marks. Original order: CS 1-55, then GA 56-65.
Answers use only the ORS code A column of the supplied final key.

Run ../start-quiz.cmd on Windows or ../start-quiz.command on macOS, then open:
http://127.0.0.1:8765/gate-cse-2013/
Node.js is required; no packages, build step, account or internet is needed.
Use the same browser/profile and HTTP origin for automatic draft recovery.

Includes one-question practice, Home, the question map, Mark for review,
remembered light/dark mode, six timer presets, shared scientific calculator,
full reports, Save report and Print report. Choosing an MCQ saves it before
advancing. Previous/Skip and map jumps preserve responses and flags.
Submit saves the latest attempt.json only; successful saving clears the draft
and practice flags while retaining report stars. Review last attempt regrades
the saved report without replacing a draft; Back to quiz restores its slide.
Attempt again starts fresh practice without changing the saved submission.
Unfinished responses, flags and the timer cache automatically in this browser.
Clearing browser data or ending a private session can erase them. A running
timer counts elapsed time while closed and never submits automatically.

Marking follows cover instructions 5, 7, 8 and 9 of the supplied paper:
CS 1-25 / GA 56-60: +1; CS 26-55 / GA 61-65: +2.
Ordinary wrong answers: exact -1/3 or -2/3; unanswered: zero.
CS-42 and CS-47 receive two marks to all, including unanswered responses.
Linked pairs: CS-53 requires CS-52; CS-55 requires CS-54. Each dependent
has zero wrong-answer penalty. If its first question is wrong/unanswered,
an answered dependent is Not evaluated for zero marks; blank stays unanswered.
Common-data pairs 48/49 and 50/51 grade independently.
Blank: 4/100. Perfect: 63 correct plus 2 awards, 100/100.
All wrong: -80/3 out of 100, including the awards and blocked dependents.

The 69 lossless PNG crops at 240 DPI provide 73 displayed image parts.
All four shared statements/code blocks repeat on each relevant slide.
PDFium preserves the source PDF's Symbol-font glyphs. Images retain original
white-paper colors in light mode/print and invert through CSS in dark mode.
Every source/key page and question crop was visually checked. Final crops
match fresh PDFium source renders at the recorded rectangles pixel-for-pixel.

Unchanged originals remain in C:/Users/ipsdas/Downloads:
GATE2013.pdf (20 pages, including six rough-work pages) and Key_CS_2013.pdf
(2 pages). No PDF copies are stored in this quiz folder. Source filenames,
SHA-256 hashes, page sizes and crop rectangles are recorded in quiz-data.js.
No exam session/date is inferred from booklet code A.

Verification: node tests/quiz-2013.test.cjs checks the independent booklet-A
key, all 260 choices, 18 linked combinations, awards, common data, crops,
scores, drafts, flags, timer/carousel and temporary-server recomputation.
Tests never submit to the user's real quiz or reset existing attempts.
