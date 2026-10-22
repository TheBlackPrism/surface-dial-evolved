package ch.theblackprism.dial

import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.execution.runners.ExecutionUtil
import com.intellij.execution.ui.RunContentManager
import com.intellij.ide.DataManager
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ExecutionDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.extensions.PluginAware
import com.intellij.openapi.extensions.PluginDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.IdeFocusManager
import com.intellij.openapi.wm.IdeFrame
import com.intellij.openapi.wm.WindowManager
import io.netty.buffer.Unpooled
import io.netty.channel.ChannelHandlerContext
import io.netty.handler.codec.http.DefaultFullHttpResponse
import io.netty.handler.codec.http.FullHttpRequest
import io.netty.handler.codec.http.HttpHeaderNames
import io.netty.handler.codec.http.HttpRequest
import io.netty.handler.codec.http.HttpResponseStatus
import io.netty.handler.codec.http.HttpVersion
import io.netty.handler.codec.http.QueryStringDecoder
import org.jetbrains.ide.RestService
import java.awt.Component
import java.net.InetSocketAddress
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.HexFormat
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import javax.swing.SwingUtilities

private val LOG = logger<DialRestService>()

/**
 * Bridge for the Surface Dial GNOME Shell extension, served on the built-in server:
 *   GET /api/dial/ping
 *   GET /api/dial/action?id=<ActionId>   (special id: dial.rerunHotSwap)
 */
class DialRestService : RestService(), PluginAware {
    private companion object {
        const val TOKEN_HEADER = "X-Dial-Token"
        const val PLACE = "SurfaceDial"
        const val RERUN_HOTSWAP = "dial.rerunHotSwap"
        /**
         * Fallbacks when no HotSwap run exists. HotSwap.debug is a Services-dashboard ExecutorAction (usually disabled
         * outside the Services tool window); HotSwap.debug.toolbar debugs the selected run configuration.
         */
        val HOTSWAP_ACTIONS = listOf("HotSwap.debug", "HotSwap.debug.toolbar")
        /** Executor id of com.vaadin.plugin.hotswapagent.HotswapAgentExecutor (Vaadin plugin 1.6.5). */
        const val HOTSWAP_EXECUTOR_ID = "Vaadin.HotswapAgentExecutor"
        const val TIMEOUT_SECONDS = 10L
        val TOKEN_FILE: Path = Path.of(System.getProperty("user.home"), ".config", "surface-dial-evolved", "intellij-token")
    }

    private class DialException(val status: HttpResponseStatus, message: String) : Exception(message)

    /** Injected by the extension system (public alternative to the internal PluginManager lookups). */
    @Volatile
    private var pluginDescriptor: PluginDescriptor? = null

    override fun setPluginDescriptor(pluginDescriptor: PluginDescriptor) {
        this.pluginDescriptor = pluginDescriptor
    }

    override fun getServiceName(): String = "dial"

    // A dial produces bursts of events; the platform default (~30/min) is far too low.
    override fun getMaxRequestsPerMinute(): Int = 6000

    // Let requests carrying an Origin header reach process() so they get an explicit 403 there
    // (the default would make the dispatcher skip this handler entirely).
    override fun isOriginAllowed(request: HttpRequest): OriginCheckResult = OriginCheckResult.ALLOW

    // Skip the platform's "trust this origin?" dialog: process() has already verified loopback peer,
    // absence of Origin and a valid token; re-check the header-based parts here defensively.
    override fun isHostTrusted(request: FullHttpRequest, urlDecoder: QueryStringDecoder): Boolean =
        request.headers().get(HttpHeaderNames.ORIGIN) == null && tokenMatches(request)

    override fun process(urlDecoder: QueryStringDecoder, request: FullHttpRequest, context: ChannelHandlerContext): Boolean {
        if (request.headers().get(HttpHeaderNames.ORIGIN) != null) {
            sendJson(HttpResponseStatus.FORBIDDEN, error("Origin header not allowed"), request, context)
            return true
        }
        val remote = context.channel().remoteAddress() as? InetSocketAddress
        if (remote?.address?.isLoopbackAddress != true) {
            sendJson(HttpResponseStatus.FORBIDDEN, error("loopback only"), request, context)
            return true
        }
        if (!tokenMatches(request)) {
            sendJson(HttpResponseStatus.UNAUTHORIZED, error("missing or invalid $TOKEN_HEADER"), request, context)
            return true
        }
        return super.process(urlDecoder, request, context)
    }

    override fun execute(urlDecoder: QueryStringDecoder, request: FullHttpRequest, context: ChannelHandlerContext): String? {
        when (urlDecoder.path().trimEnd('/').substringAfter("/$PREFIX/${getServiceName()}", "").trim('/')) {
            "ping" -> sendJson(HttpResponseStatus.OK, """{"name":"surface-dial-evolved","version":${quote(pluginVersion())}}""", request, context)
            "action" -> {
                val id = getStringParameter("id", urlDecoder)
                if (id.isNullOrBlank()) {
                    sendJson(HttpResponseStatus.BAD_REQUEST, error("missing id parameter"), request, context)
                } else {
                    runOnEdt(id).whenComplete { _, t ->
                        val (status, body) = when (val cause = t?.let { (it as? java.util.concurrent.CompletionException)?.cause ?: it }) {
                            null -> HttpResponseStatus.OK to """{"ok":true}"""
                            is DialException -> cause.status to error(cause.message ?: "")
                            is TimeoutException -> HttpResponseStatus.SERVICE_UNAVAILABLE to error("timed out waiting for the IDE (modal dialog open?)")
                            else -> {
                                LOG.warn("Surface Dial action '$id' failed", cause)
                                HttpResponseStatus.INTERNAL_SERVER_ERROR to error(cause.toString())
                            }
                        }
                        sendJson(status, body, request, context)
                    }
                }
            }
            else -> sendJson(HttpResponseStatus.NOT_FOUND, error("unknown endpoint"), request, context)
        }
        return null
    }

    // ---- action execution -------------------------------------------------------------------------

    /** Schedules the action on the EDT; the future completes once the action has been performed (or rejected). */
    private fun runOnEdt(id: String): CompletableFuture<Unit> {
        val result = CompletableFuture<Unit>()
        val cancelled = AtomicBoolean(false)
        ApplicationManager.getApplication().invokeLater({
            if (cancelled.get()) return@invokeLater // request timed out; don't replay stale dial events
            try {
                if (id == RERUN_HOTSWAP) rerunHotSwap(result) else invokeAction(id, result)
            } catch (t: Throwable) {
                result.completeExceptionally(t)
            }
        }, ModalityState.nonModal())
        return result.orTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS).whenComplete { _, t -> if (t is TimeoutException) cancelled.set(true) }
    }

    private fun invokeAction(id: String, result: CompletableFuture<Unit>) {
        val actionManager = ActionManager.getInstance()
        val action = actionManager.getAction(id)
            ?: throw DialException(HttpResponseStatus.NOT_FOUND, "unknown action id: $id")
        val (_, component) = focusedTarget()
        // tryToExecute runs a proper update session (incl. BGT updates) on a DataContext built from
        // `component`, and only performs the action if its presentation is enabled.
        val callback = actionManager.tryToExecute(action, null, component, PLACE, true)
        callback.doWhenDone { result.complete(Unit) }
        callback.doWhenRejected { reason: String? ->
            val disabled = reason == null || reason.contains("disabled", ignoreCase = true)
            result.completeExceptionally(
                if (disabled) DialException(HttpResponseStatus.CONFLICT, "action '$id' is disabled in the current context")
                else DialException(HttpResponseStatus.INTERNAL_SERVER_ERROR, "action '$id' rejected: $reason")
            )
        }
    }

    /** Restarts the most recent run whose executor is Vaadin's HotSwap executor, else falls back to the HotSwap actions. */
    private fun rerunHotSwap(result: CompletableFuture<Unit>) {
        val (project, _) = focusedTarget()
        val env = project?.let { latestHotSwapEnvironment(it) }
        if (env != null) {
            ExecutionUtil.restart(env)
            result.complete(Unit)
        } else {
            invokeFirstEnabled(HOTSWAP_ACTIONS, result)
        }
    }

    /** Tries each action in turn; moves on when one is unknown (404) or disabled (409), reporting the last failure. */
    private fun invokeFirstEnabled(ids: List<String>, result: CompletableFuture<Unit>) {
        val attempt = CompletableFuture<Unit>()
        attempt.whenComplete { _, t ->
            val retry = ids.size > 1 && t is DialException &&
                (t.status == HttpResponseStatus.NOT_FOUND || t.status == HttpResponseStatus.CONFLICT)
            when {
                retry -> ApplicationManager.getApplication().invokeLater({ invokeFirstEnabled(ids.drop(1), result) }, ModalityState.nonModal())
                t != null -> result.completeExceptionally(t)
                else -> result.complete(Unit)
            }
        }
        try {
            invokeAction(ids.first(), attempt)
        } catch (t: Throwable) {
            attempt.completeExceptionally(t)
        }
    }

    private fun latestHotSwapEnvironment(project: Project): ExecutionEnvironment? {
        val dataManager = DataManager.getInstance()
        return RunContentManager.getInstance(project).allDescriptors
            .mapNotNull { descriptor ->
                // Same lookup ExecutionUtil.restart(descriptor) performs internally.
                descriptor.component?.let { dataManager.getDataContext(it).getData(ExecutionDataKeys.EXECUTION_ENVIRONMENT) }
            }
            .filter { it.executor.id == HOTSWAP_EXECUTOR_ID }
            .maxByOrNull { it.executionId }
    }

    /** The most recently focused project frame and the last focused component inside it. */
    private fun focusedTarget(): Pair<Project?, Component?> {
        val focusManager = IdeFocusManager.getGlobalInstance()
        val frame: IdeFrame? = focusManager.lastFocusedFrame?.takeIf { it.project != null }
            ?: getLastFocusedOrOpenedProject()?.let { WindowManager.getInstance().getIdeFrame(it) }
        val project = frame?.project ?: getLastFocusedOrOpenedProject()
        val frameComponent = frame?.component ?: return project to null
        val window = SwingUtilities.getWindowAncestor(frameComponent)
        val focused = window?.let { (project?.let { p -> IdeFocusManager.getInstance(p) } ?: focusManager).getLastFocusedFor(it) }
        return project to (focused ?: frameComponent)
    }

    // ---- token ---------------------------------------------------------------------------------------

    private fun tokenMatches(request: HttpRequest): Boolean {
        // Load (or create) the token before looking at the header: the extension only learns the
        // token from the file, so its first, token-less request has to create it.
        val expected = try {
            loadOrCreateToken()
        } catch (e: Exception) {
            LOG.warn("Cannot read or create $TOKEN_FILE", e)
            return false
        }
        val given = request.headers().get(TOKEN_HEADER)?.trim() ?: return false
        return MessageDigest.isEqual(given.toByteArray(Charsets.UTF_8), expected.toByteArray(Charsets.UTF_8))
    }

    @Synchronized
    private fun loadOrCreateToken(): String {
        if (Files.exists(TOKEN_FILE)) {
            val existing = Files.readString(TOKEN_FILE).trim()
            if (existing.isNotEmpty()) return existing
            Files.delete(TOKEN_FILE)
        }
        val dir = TOKEN_FILE.parent
        Files.createDirectories(dir, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")))
        val token = HexFormat.of().formatHex(ByteArray(32).also { SecureRandom().nextBytes(it) })
        val tmp = Files.createTempFile(dir, ".intellij-token", ".tmp", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
        try {
            Files.writeString(tmp, token + "\n")
            // Hard link = atomic, never overwrites a token created concurrently by someone else.
            Files.createLink(TOKEN_FILE, tmp)
        } catch (_: FileAlreadyExistsException) {
            return Files.readString(TOKEN_FILE).trim()
        } finally {
            Files.deleteIfExists(tmp)
        }
        LOG.info("Generated Surface Dial token at $TOKEN_FILE")
        return token
    }

    // ---- helpers -------------------------------------------------------------------------------------

    private fun pluginVersion(): String = pluginDescriptor?.version ?: "unknown"

    private fun error(message: String) = """{"ok":false,"error":${quote(message)}}"""

    private fun quote(s: String): String = gson.toJson(s)

    private fun sendJson(status: HttpResponseStatus, json: String, request: HttpRequest, context: ChannelHandlerContext) {
        val response = DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status, Unpooled.copiedBuffer(json, Charsets.UTF_8))
        response.headers()
            .set(HttpHeaderNames.CONTENT_TYPE, "application/json; charset=utf-8")
            .set(HttpHeaderNames.CONTENT_LENGTH, response.content().readableBytes())
            .set(HttpHeaderNames.CACHE_CONTROL, "no-store")
        sendResponse(request, context, response)
    }
}
