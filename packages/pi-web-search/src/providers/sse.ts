import { TextDecoder } from "util";

export type SseEvent = {
    event: string;
    data: any;
};

export async function readSseEvents(
    response: Response,
    signal: AbortSignal | undefined,
    onEvent: (event: SseEvent) => boolean | void | Promise<boolean | void>
): Promise<void> {
    signal?.throwIfAborted();
    if (!response.body) {
        throw new Error("Invalid response: the SSE response has no body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEventData: string[] = [];
    let currentEventName = "";
    let eventCount = 0;
    let stopRequested = false;
    let reachedEof = false;

    const flushEvent = async (): Promise<boolean> => {
        const raw = currentEventData.join("\n").trim();
        currentEventData = [];
        const eventName = currentEventName;
        currentEventName = "";
        if (!raw || raw === "[DONE]") return false;

        let data: any;
        try {
            data = JSON.parse(raw);
        } catch {
            throw new Error("Invalid response: malformed JSON in an SSE data event.");
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new Error("Invalid response: an SSE data event must contain a JSON object.");
        }
        eventCount++;
        const stop = await onEvent({ event: eventName, data }) === true;
        signal?.throwIfAborted();
        return stop;
    };

    const processLine = async (line: string): Promise<boolean> => {
        if (!line) return flushEvent();
        if (line.startsWith("data:")) {
            currentEventData.push(line.slice(5).replace(/^ /, ""));
        } else if (line.startsWith("event:")) {
            currentEventName = line.slice(6).trim();
        }
        return false;
    };

    // Cancel a pending read as well as checking between chunks. Mock streams and
    // custom transports do not necessarily wire the request signal to their body.
    const onAbort = () => { void reader.cancel().catch(() => {}); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
        readLoop: while (true) {
            signal?.throwIfAborted();
            const { done, value } = await reader.read();
            signal?.throwIfAborted();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

            // Keep a trailing CR until the next chunk to distinguish CRLF from
            // a standalone CR. Both are valid SSE line endings.
            let lineEnd: number;
            while ((lineEnd = buffer.search(/[\r\n]/)) >= 0) {
                if (!done && buffer[lineEnd] === "\r" && lineEnd === buffer.length - 1) break;
                const line = buffer.slice(0, lineEnd);
                const separatorLength = buffer[lineEnd] === "\r" && buffer[lineEnd + 1] === "\n" ? 2 : 1;
                buffer = buffer.slice(lineEnd + separatorLength);
                if (await processLine(line)) {
                    stopRequested = true;
                    break readLoop;
                }
            }
            if (done) {
                reachedEof = true;
                break;
            }
        }

        if (!stopRequested && buffer) stopRequested = await processLine(buffer);
        if (!stopRequested) await flushEvent();
        signal?.throwIfAborted();
        if (eventCount === 0) {
            throw new Error("Invalid response: the SSE stream contained no JSON data events.");
        }
    } finally {
        signal?.removeEventListener("abort", onAbort);
        if (!reachedEof) {
            try {
                await reader.cancel();
            } catch {
                // Ignore cancellation failures while cleaning up an interrupted stream.
            }
        }
        reader.releaseLock();
    }
}
