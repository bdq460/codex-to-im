/** Browser code embedded once in the existing workbench; no configuration writes on run controls. */
export const RUNTIME_CONTROL_SCRIPT = String.raw`
      function renderRuntimeControls() {
        const status = state.bridgeStatus;
        const action = state.localBridgeOperation || state.bridgeOperation;
        const running = !!(status && status.running);
        const labels = { start: '启动中…', stop: '停止中…', restart: '重启中…' };
        const starts = document.getElementById('startBridgeBtn');
        const stops = document.getElementById('stopBridgeBtn');
        const restarts = document.getElementById('restartBridgeBtn');
        starts.hidden = running && action !== 'start';
        stops.hidden = !running && action !== 'stop';
        restarts.hidden = !running && action !== 'restart';
        for (const button of [starts, stops, restarts]) button.disabled = !!action || !status;
        starts.textContent = action === 'start' ? labels.start : '启动桥接服务';
        stops.textContent = action === 'stop' ? labels.stop : '停止桥接服务';
        restarts.textContent = action === 'restart' ? labels.restart : '重启桥接服务';
        document.getElementById('bridgeStatus').textContent = action ? labels[action] : !status ? '读取状态中…' : running ? '运行中' : '已停止';
      }
      async function refreshRuntimeStatus() {
        const data = await api('/api/status');
        state.bridgeStatus = data.bridge || null;
        state.bridgeOperation = data.bridgeOperation || null;
        renderRuntimeControls();
        const adapters = data.bridge && data.bridge.adapters || [];
        document.getElementById('bridgeStatusMeta').textContent = adapters.length
          ? '运行实例 ' + adapters.filter(item => item.running).length + ' / ' + adapters.length
          : data.bridge && data.bridge.running ? '服务运行中，等待通道连接' : '服务已停止';
      }
      async function performBridgeOperation(action) {
        if (state.localBridgeOperation || state.bridgeOperation) return;
        state.localBridgeOperation = action;
        renderRuntimeControls();
        let operationError = null;
        try {
          const result = await api('/api/bridge/' + action, { method: 'POST' });
          const expected = action !== 'stop';
          if (!result.status || result.status.running !== expected) throw new Error(result.status && result.status.error || '操作未完成，请查看日志后重试。');
          state.bridgeStatus = result.status;
          await refreshRuntimeStatus();
          if (state.bridgeStatus.running !== expected) throw new Error('服务状态未达到预期，请查看日志。');
          showMessage('opsMessage', 'success', { start: '桥接服务已启动。', stop: '桥接服务已停止。', restart: '桥接服务已重启。' }[action]);
        } catch (error) { operationError = error; showMessage('opsMessage', 'error', error.message); }
        finally {
          state.localBridgeOperation = null;
          try { await refreshRuntimeStatus(); }
          catch { state.bridgeStatus = null; if (!operationError) showMessage('opsMessage', 'error', '暂时无法确认服务状态，请刷新后查看。'); }
          renderRuntimeControls();
          void loadBindings().catch(() => {});
          void loadLogs().catch(() => {});
        }
      }
`;
