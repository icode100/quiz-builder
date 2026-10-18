GATE CSE 2017 - Set 1, 11 February 2017, session 1.
65 questions, 100 marks: 45 MCQ and 20 NAT.
Original order/numbering: CS 1-55, then GA 56-65.

Start ../start-quiz.command on macOS or ../start-quiz.cmd on Windows, then open:
http://127.0.0.1:8765/gate-cse-2017-set-1/
Node.js is required; no packages, build step, account, or internet is needed.
Use the same browser/profile and HTTP origin for unfinished draft recovery.

Responses, review flags, and the timer cache automatically in this browser.
Clearing browser data or ending a private session can erase the draft. If
caching fails, keep the tab open. Mark for review does not affect scoring.
Clear response preserves its flag; Clear answers and Attempt again clear flags.

Timer presets: 180, 150, 120, 90, 60, or 30 minutes. Start/Pause/Reset control
the countdown. Running timers count elapsed time while closed. At zero you
can keep answering. Submit resets the timer before validation; Clear answers
preserves it. Timer state never enters the saved submission.

Submit displays a full report and saves only the latest attempt.json.
The draft clears only after a successful save. Invalid numerical input or
server failure preserves it. Review last attempt regrades the saved responses
without replacing the current draft; Back to quiz restores the previous view.
Attempt again starts fresh practice and preserves the saved submission.
Save report, Print report, remembered theme, question map, and the shared
scientific calculator are included. Report colors show verified outcomes;
marked questions retain their outcome color with a star.

MCQ wrong answers deduct exactly one-third of the question marks; NAT has
no negative marking. Unanswered questions score zero. The supplied paper's
-0.33/-0.66 labels are rounded; full precision follows the GATE 2017 Information
Brochure, sections 5.4 and 5.4.6, read through this committee-authored mirror:
https://www.slideshare.net/slideshow/gate-exam-2017/66415456
No MTA or alternative MCQ answers. CS-45 accepts 86.5-89.5 and CS-50 accepts
1.49-1.52, inclusive. All other NAT keys are exact, including CS-49 = -16.
Blank: 0/100; perfect: 100/100; all wrong: -67/3 out of 100.

Sources remain unchanged under /Users/icode100/Downloads:
GATE2017-Set-1_compressed1.pdf (27-page paper)
GATE2017-Set-1.pdf (2-page answer key)
Their filenames and SHA-256 hashes are recorded in quiz-data.js. No original
PDF copies are stored here; all quiz assets are local and self-contained.
All 27 paper pages, both key pages, and all 65 final PNGs were visually checked.
Crops use 240 DPI and recorded PDF-point rectangles. They preserve the source's
inherent raster softness. CS-28 is trimmed to remove overlapping header pixels.

Verification: node tests/quiz-2017-set-1.test.cjs checks an independent key,
all MCQ options, NAT boundaries, scores/reports/maps, crops/provenance, draft
and review lifecycle, storage/write failures, and disposable-server scores.
Tests never create or reset real submissions.
