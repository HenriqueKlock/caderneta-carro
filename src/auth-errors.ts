/** Traduz os limites do Supabase Auth: o envio de e-mails do projeto e o intervalo por usuário. */
export function loginEmailError(message: string): string {
  if (/email rate limit/i.test(message)) {
    return 'O limite de e-mails de login do servidor foi atingido (poucos por hora). Tente de novo em até uma hora; aparelhos já conectados continuam sincronizando.';
  }
  const secs = /after (\d+) seconds?/i.exec(message);
  if (secs) return 'Por segurança, aguarde ' + secs[1] + ' segundos antes de pedir outro link.';
  if (/rate|too many/i.test(message)) return 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.';
  return message;
}
