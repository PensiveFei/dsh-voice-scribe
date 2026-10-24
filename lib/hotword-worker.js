// SPDX-License-Identifier: MIT
// A disposable worker keeps arbitrary hot.txt regexes away from the host loop.
import { parentPort, workerData } from "node:worker_threads";
import { applyHotwords, MAX_HOTWORD_OUTPUT_CHARS } from "./host-utils.js";

if (parentPort) {
	try {
		const text = applyHotwords(workerData.text, workerData.rules, MAX_HOTWORD_OUTPUT_CHARS);
		parentPort.postMessage({ text });
	} catch {
		// Never send user speech, rule content, paths or exception text in errors.
		parentPort.postMessage({ error: "hotword-output-limit" });
	}
}
