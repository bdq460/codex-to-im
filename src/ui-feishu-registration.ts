/** Registration stays inside a modal; only deliberate actions open external pages. */
export const FEISHU_REGISTRATION_SCRIPT = String.raw`
      let feishuRegistrationId = null;
      let feishuRegistrationTimer = null;
      let feishuRegistrationGeneration = 0;
      let feishuRegistrationStarting = false;
      async function closeFeishuRegistration() {
        feishuRegistrationGeneration++;
        window.clearTimeout(feishuRegistrationTimer);
        const id = feishuRegistrationId;
        feishuRegistrationId = null;
        document.getElementById('feishuRegistrationDialog').close();
        if (id) await api('/api/channels/feishu-registration/cancel', { method: 'POST', body: JSON.stringify({sessionId:id}) }).catch(() => {});
      }
      async function startFeishuRegistration() {
        if (feishuRegistrationStarting) return;
        feishuRegistrationStarting = true;
        const previousId = feishuRegistrationId;
        feishuRegistrationId = null;
        if (previousId) void api('/api/channels/feishu-registration/cancel', {method:'POST',body:JSON.stringify({sessionId:previousId})}).catch(() => {});
        const generation = ++feishuRegistrationGeneration;
        window.clearTimeout(feishuRegistrationTimer);
        const dialog = document.getElementById('feishuRegistrationDialog');
        if (!dialog.open) dialog.showModal();
        const message = document.getElementById('feishuRegistrationStatus');
        const qr = document.getElementById('feishuRegistrationQr');
        const link = document.getElementById('feishuRegistrationLink');
        qr.replaceChildren(); link.hidden = true;
        message.textContent = '正在生成二维码…';
        document.getElementById('feishuRegistrationRetry').disabled = true;
        try {
          const channel = getChannelById(state.activeChannelId);
          const aliasInput = document.getElementById('channelAliasInput');
          const siteInput = document.getElementById('channelSite');
          const result = await api('/api/channels/feishu-registration/start', { method:'POST', body:JSON.stringify({alias:aliasInput ? aliasInput.value : '飞书',site:siteInput ? siteInput.value : 'feishu'}) });
          if (generation !== feishuRegistrationGeneration) { void api('/api/channels/feishu-registration/cancel',{method:'POST',body:JSON.stringify({sessionId:result.session.id})}); return; }
          const session = result.session;
          feishuRegistrationId = session.id;
          const image = document.createElement('img');
          image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(session.qrSvg);
          image.alt = '使用飞书扫描添加机器人'; image.width = 256; image.height = 256;
          qr.replaceChildren(image);
          link.href = session.verificationUrl; link.hidden = false;
          message.textContent = session.message;
          const poll = async () => {
            if (generation !== feishuRegistrationGeneration || !dialog.open) return;
            try {
              const result = await api('/api/channels/feishu-registration/poll',{method:'POST',body:JSON.stringify({sessionId:session.id})});
              if (generation !== feishuRegistrationGeneration) return;
              message.textContent = result.session.message;
              if (result.session.status === 'confirmed') {
                const oldIds = new Set((state.config.channels || []).map(c => c.id));
                state.channelDraft = null;
                fillForm(result.config);
                const added = (result.config.channels || []).find(c => c.provider === 'feishu' && !oldIds.has(c.id));
                if (added) state.activeChannelId = added.id;
                renderChannelsWorkspace();
                showMessage('channelMessage','success','飞书通道已添加。可测试连接；运行中服务会自动加载通道配置。');
                link.hidden = true; qr.replaceChildren();
                return;
              }
              if (result.session.status !== 'waiting') { link.hidden = true; qr.replaceChildren(); return; }
              feishuRegistrationTimer = window.setTimeout(poll, result.session.interval * 1000);
            } catch (error) { message.textContent = error.message + ' 可重新生成或手动配置。'; }
          };
          feishuRegistrationTimer = window.setTimeout(poll, session.interval * 1000);
        } catch (error) { if (generation === feishuRegistrationGeneration) message.textContent = error.message; }
        finally { feishuRegistrationStarting = false; document.getElementById('feishuRegistrationRetry').disabled = false; }
      }
`;
