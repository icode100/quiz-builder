GATE CSE 2015 - Set 2 (7 February, afternoon / Shift 2)

Open http://127.0.0.1:8765/gate-cse-2015-set-2/
Start the local server with ../start-quiz.command on macOS or
../start-quiz.cmd on Windows. Node.js is required; no packages or internet
connection are needed. The Mac launcher opens no browser unless given
--with-browser. Keep the same browser/profile and 127.0.0.1:8765 origin.

65 questions: 43 MCQ and 22 NAT, totaling 100 marks. Numbering follows the
supplied combined paper/key: GA 1-10, then CS 11-65. The clean paper arranges
the same questions differently; every question was matched by its content.
Original PDFs remain unchanged in Downloads, outside this quiz folder:
2015CS_S06_compressed.pdf (25 pages); GATE2015-Set-2.pdf (21 pages).
quiz-data.js records their SHA-256 hashes, cross-reference and crop provenance.

All 65 complete question crops use original 240 DPI pixels without key blocks
or PDF annotations. Source raster softness remains. Light mode and print use
original colours; dark mode inverts their appearance only. Long questions
scroll naturally. On phones, scroll a wide question image sideways to read.

GA 1-5 and CS 11-35 carry one mark; the rest carry two. Wrong MCQ answers
deduct exactly one-third of their marks; NAT and unanswered questions have no
penalty. CS-42 accepts 6.1-6.2 inclusive; all other NAT answers are exact.
No MSQ, alternative answers, awards or linked dependencies. Blank: 0/100;
perfect: 100/100; all wrong: -22/100, before syllabus exclusions.

The inherited quiz includes remembered theme, timer, question map, automatic
draft recovery, last-question restoration, Mark for review, Out of syllabus,
Rough work and the shared calculator. Exclusions retain responses but remove
their marks from both earned and eligible totals. Reports show percentage
first, then earned/eligible marks and every question's outcome.

Submit writes the latest attempt.json; a draft clears only after saving
succeeds. Review last attempt preserves current practice; Back to quiz returns
to it. Attempt again never overwrites the saved attempt. Save report and Print
report remain available. Drawing notes save separately per question and survive
Submit, Clear answers and Retry. Browser-data removal can erase drafts/notes.

Verification: node tests/quiz-2015-set-2.test.cjs
Independent key, every MCQ choice, numerical boundaries, scores, PNG provenance,
draft/report/review/exclusion behavior and disposable-server recomputation.
All 46 source pages and 65 crops visually audited; every crop matched a fresh
source render. Browser checks used 1366x768, 1440x900 and 390x844 at 100% zoom
in both themes, without creating a real attempt. Shared runtime tests passed.
