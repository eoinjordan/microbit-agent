/* eslint-env browser */
/*
 * Small client for the classroom microbit-agent service.
 * This is framework-free so it can be reused from a MakeCode fork, iframe panel,
 * or local prototype page before being wired into PXT editor internals.
 */
(function (root) {
    "use strict";

    function MicrobitAgentBridge(options) {
        options = options || {};
        this.endpoint = (options.endpoint || "http://127.0.0.1:3097").replace(/\/$/, "");
        this.studentName = options.studentName || "Student";
        this.className = options.className || "";
        this.pollMs = options.pollMs || 3000;
        this.timeoutMs = options.timeoutMs || 120000;
    }

    MicrobitAgentBridge.prototype.run = async function (action, params) {
        var res = await fetch(this.endpoint + "/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: action, params: params || {} })
        });
        var data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || ("HTTP " + res.status));
        return data;
    };

    MicrobitAgentBridge.prototype.submit = function (request) {
        request = request || {};
        return this.run("submit_help", {
            studentName: request.studentName || this.studentName,
            className: request.className || this.className,
            question: request.question || "",
            code: request.code || "",
            helpType: request.helpType || "debug",
            source: request.source || "makecode",
            language: request.language || "javascript",
            blocksXml: request.blocksXml || null
        });
    };

    MicrobitAgentBridge.prototype.getResponse = function (id) {
        return this.run("get_response", { id: id });
    };

    MicrobitAgentBridge.prototype.waitForResponse = async function (id) {
        var started = Date.now();
        while (Date.now() - started < this.timeoutMs) {
            var data = await this.getResponse(id);
            if (data.status === "approved" || data.status === "rejected" || data.status === "llm_error") {
                return data;
            }
            await new Promise(function (resolve) { setTimeout(resolve, this.pollMs); }.bind(this));
        }
        throw new Error("Timed out waiting for teacher-reviewed response");
    };

    root.MicrobitAgentBridge = MicrobitAgentBridge;
})(typeof window !== "undefined" ? window : globalThis);
