/// <reference lib="webworker" />
const worker = self;
const runtimeBaseUrl = new URL("./", self.location.href);
const engineBaseUrl = new URL("engine/", runtimeBaseUrl);
const manifestUrl = new URL("runtime-manifest.json", runtimeBaseUrl);
const texEnvironment = {
    HOME: "/work",
    TMPDIR: "/work",
    TEXMFCNF: "/texmf/web2c",
    TEXFORMATS: "/texmf/web2c",
    TEXINPUTS: ".:/work//:/texmf/tex//",
    TEXMFVAR: "/work/texmf-var",
    TEXMFCONFIG: "/work/texmf-config",
    TEXMFHOME: "/work/texmf-home",
    TFMFONTS: ".:/texmf/fonts/tfm//",
    VFFONTS: ".:/texmf/fonts/vf//",
    TEXFONTMAPS: ".:/texmf/fonts/map//",
    DVIPDFMXINPUTS: ".:/texmf/dvipdfmx//:/texmf/tex//",
    BIBINPUTS: ".:/work//:/texmf/bibtex/bib//",
    BSTINPUTS: ".:/work//:/texmf/bibtex/bst//",
    ENCFONTS: ".:/texmf/fonts/enc//",
    CMAPFONTS: ".:/texmf/fonts/cmap//",
    OPENTYPEFONTS: ".:/fonts//:/texmf/fonts/opentype//",
    TTFONTS: ".:/fonts//:/texmf/fonts/truetype//",
    T1FONTS: ".:/texmf/fonts/type1//",
    ICU_DATA: "/icu",
    FONTCONFIG_FILE: "/fontconfig/fonts.conf",
    FONTCONFIG_PATH: "/fontconfig",
    MKTEXTFM: "0",
    MKTEXPK: "0",
    MKTEXMF: "0",
    MKTEXFMT: "0",
};
let compiling = false;
function post(message, transfer = []) {
    worker.postMessage(message, transfer);
}
function getRuntimeUrl(path) {
    return new URL(path
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/"), runtimeBaseUrl).href;
}
async function importFactory(file) {
    const moduleUrl = new URL(file, engineBaseUrl).href;
    const imported = (await import(
    /* @vite-ignore */ moduleUrl));
    return imported.default;
}
async function loadRuntimeFiles() {
    const response = await fetch(manifestUrl);
    if (!response.ok) {
        throw new Error(`Runtime manifest could not be loaded (${response.status}). Run pnpm xelatex:manifest after adding the texmf, fonts, and ICU assets.`);
    }
    const manifest = (await response.json());
    if (manifest.version !== 1 || !Array.isArray(manifest.files)) {
        throw new Error("The XeLaTeX runtime manifest is invalid.");
    }
    const totalBytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
    let loadedBytes = 0;
    let loadedFiles = 0;
    let lastReportedPercent = -5;
    const reportProgress = () => {
        const percent = totalBytes === 0 ? 100 : Math.floor((loadedBytes / totalBytes) * 100);
        if (percent !== 100 && percent < lastReportedPercent + 5)
            return;
        lastReportedPercent = percent;
        post({
            type: "initialization-status",
            message: `Loading XeLaTeX runtime… ${percent}%`,
            phase: "loading-runtime",
            loadedBytes,
            loadedFiles,
            totalBytes,
            totalFiles: manifest.files.length,
        });
    };
    reportProgress();
    const fetchAsset = async (path, expectedSize) => {
        const assetResponse = await fetch(getRuntimeUrl(path));
        if (!assetResponse.ok) {
            throw new Error(`Runtime asset ${path} could not be loaded (${assetResponse.status}).`);
        }
        const bytes = new Uint8Array(await assetResponse.arrayBuffer());
        if (bytes.byteLength !== expectedSize) {
            throw new Error(`Runtime asset ${path} has ${bytes.byteLength} bytes; the manifest expects ${expectedSize}.`);
        }
        return bytes;
    };
    const files = await Promise.all(manifest.files.map(async ({ path, size, chunks }) => {
        let bytes;
        if (chunks?.length) {
            const chunkBytes = await Promise.all(chunks.map((chunk) => fetchAsset(chunk.path, chunk.size)));
            bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunkBytes) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            if (offset !== size) {
                throw new Error(`Runtime chunks for ${path} have ${offset} bytes; the manifest expects ${size}.`);
            }
        }
        else {
            bytes = await fetchAsset(path, size);
        }
        loadedBytes += bytes.byteLength;
        loadedFiles += 1;
        reportProgress();
        return {
            path: `/${path}`,
            bytes,
        };
    }));
    return { files, totalBytes };
}
post({
    type: "initialization-status",
    message: "Initializing WebAssembly XeTeX engines…",
    phase: "initializing",
});
const factoriesPromise = Promise.all([
    importFactory("xetex.mjs"),
    importFactory("xdvipdfmx.mjs"),
    importFactory("bibtex.mjs"),
]);
const runtimeFilesPromise = loadRuntimeFiles();
function installRuntime(module, runtimeFiles) {
    const { FS } = module;
    for (const directory of [
        "/work",
        "/work/texmf-var",
        "/work/texmf-config",
        "/work/texmf-home",
        "/work/fontconfig-cache",
    ]) {
        FS.mkdirTree(directory);
    }
    for (const file of runtimeFiles) {
        const separator = file.path.lastIndexOf("/");
        FS.mkdirTree(file.path.slice(0, separator));
        FS.writeFile(file.path, file.bytes);
    }
    Object.assign(module.ENV, texEnvironment);
    FS.chdir("/work");
}
function createModuleOptions(program, runtimeFiles, requestId, logLines) {
    const writeLog = (stream, value) => {
        const message = String(value);
        logLines.push(stream === "stderr" ? `[stderr] ${message}` : message);
        if (requestId) {
            post({ type: "log", requestId, stream, message });
        }
    };
    return {
        noInitialRun: true,
        thisProgram: program,
        locateFile(file) {
            return new URL(file, engineBaseUrl).href;
        },
        print(message) {
            writeLog("stdout", message);
        },
        printErr(message) {
            writeLog("stderr", message);
        },
        preRun: [
            (module) => {
                installRuntime(module, runtimeFiles);
                module.FS.writeFile(`/work/${program}`, new Uint8Array());
            },
        ],
    };
}
function requireModuleApi(module, program) {
    const missing = [
        !module.FS && "FS",
        typeof module.callMain !== "function" && "callMain",
        !module.ENV && "ENV",
    ].filter(Boolean);
    if (missing.length > 0) {
        throw new Error(`${program} is missing Emscripten runtime exports: ${missing.join(", ")}. Relink it with FS, callMain, and ENV in EXPORTED_RUNTIME_METHODS.`);
    }
}
function readRequiredFile(module, path) {
    if (!module.FS.analyzePath(path).exists) {
        throw new Error(`Expected output ${path} was not generated.`);
    }
    return module.FS.readFile(path, { encoding: "binary" });
}
function writeFiles(FS, files) {
    for (const file of files) {
        const separator = file.path.lastIndexOf("/");
        FS.mkdirTree(file.path.slice(0, separator));
        FS.writeFile(file.path, file.bytes);
    }
}
function snapshotPassFiles(FS) {
    const files = [];
    const ignoredWorkEntries = new Set([
        "fontconfig-cache",
        "main.log",
        "main.pdf",
        "main.tex",
        "main.xdv",
        "bibtex",
        "texmf-config",
        "texmf-home",
        "texmf-var",
        "xelatex",
    ]);
    function visit(directory) {
        for (const name of FS.readdir(directory)) {
            if (name === "." || name === "..") {
                continue;
            }
            if (directory === "/work" && ignoredWorkEntries.has(name)) {
                continue;
            }
            const path = `${directory}/${name}`;
            const metadata = FS.stat(path);
            if (FS.isDir(metadata.mode)) {
                visit(path);
            }
            else {
                files.push({
                    path,
                    bytes: new Uint8Array(FS.readFile(path, { encoding: "binary" })),
                });
            }
        }
    }
    visit("/work");
    return files;
}
function addLogMarker(requestId, logLines, message) {
    logLines.push(message);
    post({
        type: "log",
        requestId,
        stream: "stdout",
        message,
    });
}
async function runXeTeXPass(createXeTeXModule, runtimeFiles, requestId, logLines, source, pass, passCount, previousPassFiles, additionalFiles) {
    post({
        type: "status",
        requestId,
        message: `Running XeTeX pass ${pass} of ${passCount}…`,
        phase: "compiling",
    });
    addLogMarker(requestId, logLines, `\n===== XeTeX pass ${pass} of ${passCount} =====`);
    const xetex = await createXeTeXModule(createModuleOptions("xelatex", runtimeFiles, requestId, logLines));
    requireModuleApi(xetex, "XeTeX");
    writeFiles(xetex.FS, previousPassFiles);
    // Mount caller-supplied files (fonts, images, styles, etc.)
    for (const file of additionalFiles) {
        const vfsPath = `/work/${file.path}`;
        const separator = vfsPath.lastIndexOf("/");
        xetex.FS.mkdirTree(vfsPath.slice(0, separator));
        xetex.FS.writeFile(vfsPath, file.data);
    }
    xetex.FS.writeFile("/work/main.tex", source);
    const status = xetex.callMain([
        "-fmt=xelatex",
        "-no-pdf",
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-file-line-error",
        "-output-directory=/work",
        "/work/main.tex",
    ]);
    if (status !== 0) {
        throw new Error(`XeTeX pass ${pass} exited with status ${status}.`);
    }
    return {
        xdv: new Uint8Array(readRequiredFile(xetex, "/work/main.xdv")),
        nextPassFiles: snapshotPassFiles(xetex.FS),
    };
}
async function runBibTeX(createBibTeXModule, runtimeFiles, requestId, logLines, passFiles, additionalFiles) {
    post({
        type: "status",
        requestId,
        message: "Running BibTeX…",
        phase: "bibliography",
    });
    addLogMarker(requestId, logLines, "\n===== BibTeX =====");
    const bibtex = await createBibTeXModule(createModuleOptions("bibtex", runtimeFiles, requestId, logLines));
    requireModuleApi(bibtex, "BibTeX");
    writeFiles(bibtex.FS, passFiles);
    for (const file of additionalFiles) {
        const vfsPath = `/work/${file.path}`;
        const separator = vfsPath.lastIndexOf("/");
        bibtex.FS.mkdirTree(vfsPath.slice(0, separator));
        bibtex.FS.writeFile(vfsPath, file.data);
    }
    const status = bibtex.callMain(["main"]);
    if (status !== 0) {
        throw new Error(`BibTeX exited with status ${status}.`);
    }
    readRequiredFile(bibtex, "/work/main.bbl");
    return snapshotPassFiles(bibtex.FS);
}
async function compile(request) {
    const { bibtex: bibtexMode, passes: requestedPassCount, requestId, source } = request;
    const logLines = [];
    try {
        post({
            type: "status",
            requestId,
            message: "Loading XeLaTeX runtime…",
            phase: "loading-runtime",
        });
        const [[createXeTeXModule, createXdvipdfmxModule, createBibTeXModule], runtime] = await Promise.all([factoriesPromise, runtimeFilesPromise]);
        const runtimeFiles = runtime.files;
        if (!Number.isInteger(requestedPassCount) || requestedPassCount < 1 || requestedPassCount > 5) {
            throw new Error("XeTeX passes must be an integer between 1 and 5.");
        }
        if (bibtexMode !== true && bibtexMode !== false && bibtexMode !== "auto") {
            throw new Error('BibTeX mode must be true, false, or "auto".');
        }
        const callerFiles = request.additionalFiles ?? [];
        let previousPassFiles = [];
        let finalXdv = null;
        let bibtexRan = false;
        const sourceRequestsBibTeX = /\\bibliography\s*\{/.test(source);
        let passCount = bibtexMode !== false && sourceRequestsBibTeX
            ? Math.max(3, requestedPassCount)
            : requestedPassCount;
        for (let pass = 1; pass <= passCount; pass += 1) {
            const result = await runXeTeXPass(createXeTeXModule, runtimeFiles, requestId, logLines, source, pass, passCount, previousPassFiles, callerFiles);
            previousPassFiles = result.nextPassFiles;
            finalXdv = result.xdv;
            if (pass === 1 && bibtexMode !== false) {
                const aux = previousPassFiles.find((file) => file.path === "/work/main.aux");
                const auxText = aux ? new TextDecoder().decode(aux.bytes) : "";
                const auxRequestsBibTeX = /\\bibdata\{/.test(auxText) && /\\bibstyle\{/.test(auxText);
                if (bibtexMode === true && !auxRequestsBibTeX) {
                    throw new Error("BibTeX was requested, but main.aux contains no bibliography data and style directives.");
                }
                if (auxRequestsBibTeX) {
                    previousPassFiles = await runBibTeX(createBibTeXModule, runtimeFiles, requestId, logLines, previousPassFiles, callerFiles);
                    bibtexRan = true;
                    passCount = Math.max(3, passCount);
                }
            }
        }
        if (!finalXdv) {
            throw new Error("XeTeX did not produce an XDV document.");
        }
        post({
            type: "status",
            requestId,
            message: "Converting XDV to PDF…",
            phase: "converting",
        });
        const xdvipdfmx = await createXdvipdfmxModule(createModuleOptions("xdvipdfmx", runtimeFiles, requestId, logLines));
        requireModuleApi(xdvipdfmx, "xdvipdfmx");
        xdvipdfmx.FS.writeFile("/work/main.xdv", finalXdv);
        // Mount caller-supplied files so xdvipdfmx can resolve images and fonts.
        for (const file of callerFiles) {
            const vfsPath = `/work/${file.path}`;
            const separator = vfsPath.lastIndexOf("/");
            xdvipdfmx.FS.mkdirTree(vfsPath.slice(0, separator));
            xdvipdfmx.FS.writeFile(vfsPath, file.data);
        }
        const xdvipdfmxStatus = xdvipdfmx.callMain([
            "-o",
            "/work/main.pdf",
            "/work/main.xdv",
        ]);
        if (xdvipdfmxStatus !== 0) {
            throw new Error(`xdvipdfmx exited with status ${xdvipdfmxStatus}.`);
        }
        const pdf = readRequiredFile(xdvipdfmx, "/work/main.pdf");
        const transferablePdf = new Uint8Array(pdf).buffer;
        post({
            type: "success",
            requestId,
            pdf: transferablePdf,
            log: logLines.join("\n"),
            passes: passCount,
            bibtexRan,
        }, [transferablePdf]);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown compilation error.";
        logLines.push(`[worker] ${message}`);
        post({
            type: "error",
            requestId,
            message,
            log: logLines.join("\n"),
        });
    }
    finally {
        compiling = false;
    }
}
worker.onmessage = (event) => {
    const request = event.data;
    if (request.type !== "compile") {
        return;
    }
    if (compiling) {
        post({
            type: "error",
            requestId: request.requestId,
            message: "A document is already compiling.",
            log: "",
        });
        return;
    }
    compiling = true;
    void compile(request);
};
Promise.all([factoriesPromise, runtimeFilesPromise])
    .then(([, runtime]) => {
    post({
        type: "ready",
        runtimeBytes: runtime.totalBytes,
        runtimeFileCount: runtime.files.length,
    });
})
    .catch((error) => {
    post({
        type: "initialization-error",
        message: error instanceof Error
            ? error.message
            : "The XeLaTeX worker could not initialize.",
    });
});
export {};
//# sourceMappingURL=xelatex.worker.js.map