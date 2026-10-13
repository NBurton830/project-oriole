import { createHmac } from 'node:crypto';

/**
 * Account helpers for a homeserver you run yourself: shared-secret registration
 * (Synapse admin API, reachable from this machine only) and bot provisioning.
 */

export interface Credentials {
  userId: string;
  accessToken: string;
  deviceId: string;
}

export interface BotAccount {
  localpart: string;
  displayName: string;
  deviceId: string;
  password: string;
}

export function matrixAdmin(opts: { homeserverUrl: string; registrationSecret: string }) {
  async function hs<T>(method: string, route: string, body?: unknown, token?: string): Promise<T> {
    const res = await fetch(`${opts.homeserverUrl}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T & { errcode?: string; error?: string };
    if (!res.ok) {
      throw Object.assign(new Error(`${method} ${route} -> ${res.status} ${json.errcode ?? ''} ${json.error ?? ''}`), {
        status: res.status,
        body: json,
      });
    }
    return json;
  }

  async function waitForHomeserver(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await hs('GET', '/_matrix/client/versions');
        return;
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(`Homeserver at ${opts.homeserverUrl} not reachable. Run \`npm run groupchat:up\`. (${err})`);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  async function login(localpart: string, password: string, deviceId?: string): Promise<Credentials> {
    const res = await hs<{ user_id: string; access_token: string; device_id: string }>('POST', '/_matrix/client/v3/login', {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: localpart },
      password,
      ...(deviceId ? { device_id: deviceId } : {}),
      initial_device_display_name: deviceId ?? 'groupchat-setup',
    });
    return { userId: res.user_id, accessToken: res.access_token, deviceId: res.device_id };
  }

  async function logout(token: string) {
    await hs('POST', '/_matrix/client/v3/logout', {}, token);
  }

  /** Registers via the shared-secret admin API; logs in instead if the user already exists. */
  async function registerUser(user: { localpart: string; displayName: string; password: string }): Promise<Credentials> {
    const { nonce } = await hs<{ nonce: string }>('GET', '/_synapse/admin/v1/register');
    const mac = createHmac('sha1', opts.registrationSecret)
      .update(`${nonce}\0${user.localpart}\0${user.password}\0notadmin`)
      .digest('hex');
    try {
      const res = await hs<{ user_id: string; access_token: string; device_id: string }>('POST', '/_synapse/admin/v1/register', {
        nonce,
        username: user.localpart,
        displayname: user.displayName,
        password: user.password,
        admin: false,
        mac,
      });
      return { userId: res.user_id, accessToken: res.access_token, deviceId: res.device_id };
    } catch (err) {
      if ((err as { body?: { errcode?: string } }).body?.errcode === 'M_USER_IN_USE') return login(user.localpart, user.password);
      throw err;
    }
  }

  /** Deletes a device (and its published keys) using password UIA. */
  async function deleteDevice(creds: Credentials, localpart: string, password: string, deviceId: string) {
    const route = '/_matrix/client/v3/delete_devices';
    try {
      await hs('POST', route, { devices: [deviceId] }, creds.accessToken);
    } catch (err) {
      const { status, body } = err as { status?: number; body?: { session?: string } };
      if (status !== 401) throw err;
      await hs(
        'POST',
        route,
        {
          devices: [deviceId],
          auth: { type: 'm.login.password', identifier: { type: 'm.id.user', user: localpart }, password, session: body?.session },
        },
        creds.accessToken,
      );
    }
  }

  /** Mints the bot's access token for its fixed device id, starting from a clean device. */
  async function provisionBot(bot: BotAccount): Promise<Credentials> {
    await registerUser({ localpart: bot.localpart, displayName: bot.displayName, password: bot.password });
    const setup = await login(bot.localpart, bot.password, 'GROUPCHAT_SETUP');
    // The agent's crypto store is in memory, so keys left on the server for this
    // device id by a previous run would collide with the fresh one-time-key upload.
    await deleteDevice(setup, bot.localpart, bot.password, bot.deviceId).catch(() => undefined);
    await hs('PUT', `/_matrix/client/v3/profile/${encodeURIComponent(setup.userId)}/displayname`, { displayname: bot.displayName }, setup.accessToken);
    await logout(setup.accessToken);
    return login(bot.localpart, bot.password, bot.deviceId);
  }

  return { waitForHomeserver, registerUser, provisionBot };
}
