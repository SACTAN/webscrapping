package com.yourcompany.capture;

import java.io.*;
import java.nio.file.*;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * CaptureProcessLauncher
 * ─────────────────────────────────────────────────────────────────────────────
 * Launches capture.js as an external Node.js process from Java.
 * Use this when you want to:
 *   - Start the browser capture utility from a Java main() or test setup
 *   - Keep Java and Node.js decoupled (no Playwright Java dependency needed)
 *   - Run capture.js the same way as double-clicking START_CAPTURE.bat
 *
 * Usage:
 *   CaptureProcessLauncher launcher = new CaptureProcessLauncher("path/to/capture.js");
 *   launcher.start();
 *   // ... do your work ...
 *   launcher.stop();
 * ─────────────────────────────────────────────────────────────────────────────
 */
public class CaptureProcessLauncher {

    private final Path captureJsPath;
    private Process nodeProcess;
    private Thread logThread;

    /**
     * @param captureJsPath  Path to capture.js, e.g. "src/capture.js"
     *                       or absolute path like "C:/projects/myapp/src/capture.js"
     */
    public CaptureProcessLauncher(String captureJsPath) {
        this.captureJsPath = Path.of(captureJsPath).toAbsolutePath();
    }

    // ── Start Node.js capture process ─────────────────────────────────────────
    public void start() throws IOException {
        if (!Files.exists(captureJsPath)) {
            throw new FileNotFoundException("capture.js not found at: " + captureJsPath);
        }

        // Detect OS — Windows needs "node.exe", others just "node"
        String nodeCmd = isWindows() ? "node.exe" : "node";

        // Build the process command:  node  <path-to-capture.js>
        ProcessBuilder pb = new ProcessBuilder(
            List.of(nodeCmd, captureJsPath.toString())
        );

        // Set working directory to the folder containing capture.js
        pb.directory(captureJsPath.getParent().toFile());

        // Merge stderr into stdout so we see all output in one stream
        pb.redirectErrorStream(true);

        System.out.println("[LAUNCHER] Starting capture.js...");
        System.out.println("[LAUNCHER] Path : " + captureJsPath);

        nodeProcess = pb.start();

        // ── Stream Node.js console output to Java's System.out ────────────────
        logThread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(nodeProcess.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    System.out.println("[capture.js] " + line);
                }
            } catch (IOException ignored) {}
        }, "capture-log-stream");
        logThread.setDaemon(true);
        logThread.start();

        System.out.println("[LAUNCHER] capture.js is running (PID: " + nodeProcess.pid() + ")");
    }

    // ── Stop the Node.js process ──────────────────────────────────────────────
    public void stop() {
        if (nodeProcess != null && nodeProcess.isAlive()) {
            System.out.println("[LAUNCHER] Stopping capture.js...");
            nodeProcess.destroy();
            try {
                nodeProcess.waitFor(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            if (nodeProcess.isAlive()) {
                nodeProcess.destroyForcibly();
            }
            System.out.println("[LAUNCHER] capture.js stopped.");
        }
    }

    // ── Block until process exits (use in main() for standalone run) ──────────
    public void waitFor() throws InterruptedException {
        if (nodeProcess != null) {
            nodeProcess.waitFor();
        }
    }

    public boolean isRunning() {
        return nodeProcess != null && nodeProcess.isAlive();
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase().contains("win");
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Example 1: Standalone  — run from main(), works like double-clicking .bat
    // ─────────────────────────────────────────────────────────────────────────
    public static void main(String[] args) throws Exception {

        // Adjust this path to where your capture.js lives
        String captureJsPath = "src/capture.js";

        CaptureProcessLauncher launcher = new CaptureProcessLauncher(captureJsPath);
        launcher.start();

        System.out.println("[MAIN] Browser is open. Press Ctrl+C to stop.");

        // Add shutdown hook so Ctrl+C cleanly kills Node too
        Runtime.getRuntime().addShutdownHook(new Thread(launcher::stop));

        launcher.waitFor();  // blocks until capture.js exits
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Example 2: JUnit 5 / TestNG lifecycle usage
    //
    //  @BeforeAll
    //  static void startCapture() throws IOException {
    //      launcher = new CaptureProcessLauncher("src/capture.js");
    //      launcher.start();
    //      Thread.sleep(2000); // give browser time to open
    //  }
    //
    //  @AfterAll
    //  static void stopCapture() {
    //      launcher.stop();
    //  }
    // ─────────────────────────────────────────────────────────────────────────
}
