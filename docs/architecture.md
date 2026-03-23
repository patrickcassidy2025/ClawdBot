# Clawdbot Architecture

## Overview

Clawdbot is a self-hosted personal AI assistant running on an Ubuntu VPS.

## Main components

- VPS host
- OpenClaw runtime
- Telegram bot channel
- Claude model provider
- Workspace files for identity and operating context
- systemd service for persistence

## Design goals

- simple deployment
- controlled configuration
- secure secret handling
- easy restart and recovery
- clear documentation

## v1 boundaries

Clawdbot v1 supports:
- one server
- one primary bot
- one primary channel
- one main runtime path

Future expansion may include:
- more channels
- more tools
- multiple agent roles
- richer automation