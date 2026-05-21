export default async function handler(req, res) {
  // CORS対応ヘッダーの追加（Vercel内での呼び出し用）
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  const { storeName, webhookUrl, emails, alertItems, isTest } = req.body;

  try {
    let googleChatSuccess = false;
    let googleChatError = null;
    let emailSuccess = false;
    let emailError = null;

    // 1. Google Chat Webhook 通知の送信
    if (webhookUrl) {
      let messageText = '';
      if (isTest) {
        messageText = `✅ *【テスト通知】${storeName}*\nジム在庫管理システムの通知設定が正常に動作しています。`;
      } else if (alertItems && alertItems.length > 0) {
        const lines = [`⚠️ *【在庫アラート】${storeName}* ⚠️`, ''];
        alertItems.forEach(a => {
          lines.push(`📦 *${a.name}*  ${a.qty}${a.unit}（下限: ${a.min}${a.unit}）`);
        });
        lines.push('');
        // 日本時間のタイムスタンプを生成
        const timestamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        lines.push(`_${timestamp} 時点_`);
        messageText = lines.join('\n');
      }

      if (messageText) {
        try {
          const chatResponse = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: messageText })
          });
          if (chatResponse.ok) {
            googleChatSuccess = true;
          } else {
            googleChatError = `HTTP error! status: ${chatResponse.status}`;
          }
        } catch (err) {
          googleChatError = err.message;
        }
      }
    }

    // 2. Resend API を利用したメール送信 (オプショナル)
    const resendApiKey = process.env.RESEND_API_KEY;
    if (resendApiKey && emails) {
      const emailList = emails.split(',').map(e => e.trim()).filter(Boolean);
      if (emailList.length > 0) {
        const emailSubject = isTest ? `【テスト通知】${storeName}` : `【在庫アラート】${storeName} - 要補充`;
        const emailBody = isTest 
          ? `<p>ジム在庫管理システムの通知設定が正常に動作しています。</p><p>店舗: <strong>${storeName}</strong></p>`
          : `<h3>⚠️ 在庫アラート: ${storeName}</h3>
             <p>以下の商品の在庫が下限を下回りました。早めの補充をお願いします。</p>
             <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;font-family:sans-serif;">
               <thead style="background:#f8fafc;">
                 <tr>
                   <th>商品名</th>
                   <th>現在庫</th>
                   <th>設定下限</th>
                   <th>単位</th>
                 </tr>
               </thead>
               <tbody>
                 ${alertItems.map(a => `
                   <tr style="${a.qty < a.min ? 'background:#fef2f2;color:#dc2626;' : ''}">
                     <td><strong>${a.name}</strong></td>
                     <td align="center">${a.qty}</td>
                     <td align="center">${a.min}</td>
                     <td>${a.unit}</td>
                   </tr>
                 `).join('')}
               </tbody>
             </table>
             <p style="font-size:12px;color:#64748b;margin-top:16px;">※このメールはジム在庫管理システムから自動送信されています。</p>`;

        try {
          const resendResponse = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${resendApiKey}`
            },
            body: JSON.stringify({
              from: 'Gym Stock Alert <onboarding@resend.dev>',
              to: emailList,
              subject: emailSubject,
              html: emailBody
            })
          });

          if (resendResponse.ok) {
            emailSuccess = true;
          } else {
            const errData = await resendResponse.json();
            emailError = errData.message || `HTTP error! status: ${resendResponse.status}`;
          }
        } catch (err) {
          emailError = err.message;
        }
      }
    }

    return res.status(200).json({
      success: true,
      googleChat: { success: googleChatSuccess, error: googleChatError },
      email: { success: emailSuccess, error: emailError, enabled: !!resendApiKey }
    });

  } catch (error) {
    console.error('Notification error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
