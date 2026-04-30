import PostalMime from 'postal-mime';

export default {
  async email(message, env, ctx) {
    try {
      const rawEmail = await new Response(message.raw).arrayBuffer();
      const parsed = await new PostalMime().parse(rawEmail);

      await fetch(`${env.SERVER_URL}/api/email/inbound`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-secret': env.WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          from: message.from,
          to: message.to,
          subject: parsed.subject || '(no subject)',
          text: parsed.text || '',
          html: parsed.html || '',
        }),
      });
    } catch (err) {
      console.error('Email worker error:', err);
      // Forward raw to fallback address so no email is lost
      await message.forward(env.FORWARD_TO);
    }
  },
};
