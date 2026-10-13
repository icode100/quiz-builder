// Filled from a supplied question paper and verified answer key for each quiz.
// Loaded by a local script tag; launch through start-quiz.cmd for cache and attempt storage.
window.QUIZ_DATA = {
  id: "blank-template",
  title: "Your next quiz",
  source: "",
  instructions: "",
  scoring: { correct: 1, incorrect: 0 },
  questions: []
};

// Question format (remove this example comment when preparing a real quiz):
// {
//   id: "1",                       // Match the printed question number.
//   text: "Exact question text",
//   image: "assets/question-1.png", // Optional diagram or formula image.
//   imageAlt: "Diagram for question 1",
//   options: [
//     { id: "A", text: "First option" },
//     { id: "B", text: "Second option" }
//   ],
//   correctAnswer: "B",             // Option ID, checked against the key.
//   explanation: "",               // Optional; do not invent explanations.
//   marks: 1,                       // Optional per-question override.
//   incorrectMarks: 0              // For negative marking use e.g. -0.25.
// }
