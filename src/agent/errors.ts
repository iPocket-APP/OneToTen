const messages: Record<string, string> = {
  ACCEPT_REQUIRED: 'Use a terminal to confirm each offer, or pass --accept to receive one matching file.',
  AMBIGUOUS_PEER: 'More than one online device has this name. Use its peer ID.',
  BAD_ARGUMENTS: 'Check the command and its required options with --help.',
  CHECKPOINT_MISMATCH: 'This receiver cannot resume the partial file. Send it again.',
  DIRECT_CONNECTION_FAILED: 'Could not establish a direct WebRTC connection. Check connectivity between the devices.',
  FILE_CHANGED: 'The local file changed before or during transfer. Select the file again.',
  FILE_TOO_LARGE: 'The file exceeds the receiving device’s size limit.',
  FILE_UNAVAILABLE: 'Select an existing regular file.',
  HTTPS_REQUIRED: 'Use HTTPS or explicitly allow HTTP for a trusted local network.',
  INBOX_UNAVAILABLE: 'The configured inbox directory is unavailable.',
  INTERRUPTED: 'The operation was interrupted.',
  INVALID_DEVICE_NAME: 'Use a device name between 1 and 48 characters.',
  INVALID_INVITE: 'Use the complete invitation URL for the configured server.',
  INVALID_SERVER: 'Use the server origin, such as https://files.example.com.',
  INVALID_STUN: 'Use a stun: URL.',
  INVITE_ROTATING: 'Wait for the current invitation renewal to finish.',
  INVITE_EXPIRED: 'Ask the room host for a fresh invitation.',
  NOT_ROOM_HOST: 'Only the device that created the room can renew its invitation.',
  NO_ROOM: 'Create or join a room first.',
  OFFER_UNAVAILABLE: 'The offer is no longer waiting for confirmation.',
  PATH_OUTSIDE_SEND_DIRECTORY: 'Select a file inside the configured send directory.',
  PEER_BUSY: 'The other device is handling a file transfer.',
  PEER_OFFLINE: 'The requested device is offline or its name does not match.',
  QUOTA_EXCEEDED: 'The receiving device ran out of storage.',
  ROOM_ALREADY_OPEN: 'Leave the current room before opening another.',
  ROOM_CLOSED: 'The room ended or expired.',
  ROOM_REQUIRED: 'Supply an invitation or the server origin for a new room.',
  SAVE_UNAVAILABLE: 'The receiving device could not save the file.',
  SEND_DIRECTORY_UNAVAILABLE: 'The configured send directory does not exist or cannot be accessed.',
  SEND_DISABLED: 'Set --send-dir when starting the MCP server to allow it to send local files.',
  SERVER_REQUIRED: 'Set --server or FILE_ROOM_SERVER.',
  SIGNAL_DISCONNECTED: 'The connection to the room server was lost.',
  TIMEOUT: 'The operation timed out.',
  TRANSFER_UNAVAILABLE: 'This transfer is no longer available.',
  USER_CANCELLED: 'The transfer was cancelled.',
  USER_REJECTED: 'The receiver declined the file.',
};

export function failure(error: unknown): { code: string; message: string } {
  const code = error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT'
    : error instanceof Error && /^[A-Z_]{1,40}$/.test(error.message) ? error.message : 'OPERATION_FAILED';
  return { code, message: messages[code] ?? 'The operation could not be completed.' };
}
