package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"time"

	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing-box/protocol/vless"
	"github.com/sagernet/sing/common/metadata"
)

func sshTunnel(value string) error {
	data, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return err
	}
	var config struct {
		Server, Destination, UUID, PBK, SID, SNI string
	}
	if err = json.Unmarshal(data, &config); err != nil {
		return err
	}
	outbound, err := vless.NewOutbound(context.Background(), nil,
		log.NewNOPFactory().NewLogger(""), "", option.VLESSOutboundOptions{
			ServerOptions: option.ServerOptions{Server: config.Server, ServerPort: 443},
			UUID:          config.UUID,
			Flow:          "xtls-rprx-vision",
			OutboundTLSOptionsContainer: option.OutboundTLSOptionsContainer{
				TLS: &option.OutboundTLSOptions{
					Enabled: true, ServerName: config.SNI,
					UTLS: &option.OutboundUTLSOptions{Enabled: true, Fingerprint: "chrome"},
					Reality: &option.OutboundRealityOptions{
						Enabled: true, PublicKey: config.PBK, ShortID: config.SID,
					},
				},
			},
		})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	conn, err := outbound.DialContext(ctx, "tcp", metadata.ParseSocksaddr(config.Destination))
	if err != nil {
		return err
	}
	defer conn.Close()
	done := make(chan error, 2)
	go func() { _, err := io.Copy(conn, os.Stdin); done <- err }()
	go func() { _, err := io.Copy(os.Stdout, conn); done <- err }()
	return <-done
}
