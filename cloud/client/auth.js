import { getApps, initializeApp } from 'firebase/app';
import {
  getAuth, onAuthStateChanged, getRedirectResult, GoogleAuthProvider,
  signInWithPopup, signInWithRedirect, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendPasswordResetEmail, signOut,
  setPersistence, browserLocalPersistence, inMemoryPersistence, connectAuthEmulator
} from 'firebase/auth';
import { createAuthController, authErrorMessage } from './auth-core.mjs';

const sdk = {
  getApps, initializeApp, getAuth, onAuthStateChanged, getRedirectResult,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut, setPersistence,
  browserLocalPersistence, inMemoryPersistence, connectAuthEmulator
};
export const auth = createAuthController({
  sdk,
  config: window.QUIZ_CLOUD_CONFIG || {},
  hostname: window.location.hostname,
  eventTarget: document,
  makeEvent: (name, detail) => new CustomEvent(name, { detail })
});
window.QuizCloudAuth = auth;
export { authErrorMessage };
