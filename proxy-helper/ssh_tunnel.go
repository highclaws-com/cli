package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"time"

	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing-box/protocol/vless"
	"github.com/sagernet/sing/common/metadata"
)

// Decodes the tunnel value and returns a function that opens one connection
// to its destination through the tunnel.
func tunnelDialer(value string) (func() (net.Conn, error), error) {
	data, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, err
	}
	var config struct {
		Server, Destination, UUID, PBK, SID, SNI string
	}
	if err = json.Unmarshal(data, &config); err != nil {
		return nil, err
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
		return nil, err
	}
	return func() (net.Conn, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return outbound.DialContext(
			ctx, "tcp", metadata.ParseSocksaddr(config.Destination),
		)
	}, nil
}

// Copies bytes both ways between conn and the reader/writer pair until
// either direction ends.
func relay(conn net.Conn, reader io.Reader, writer io.Writer) error {
	done := make(chan error, 2)
	go func() { _, err := io.Copy(conn, reader); done <- err }()
	go func() { _, err := io.Copy(writer, conn); done <- err }()
	return <-done
}

func sshTunnel(value string) error {
	dial, err := tunnelDialer(value)
	if err != nil {
		return err
	}
	conn, err := dial()
	if err != nil {
		return err
	}
	defer conn.Close()
	return relay(conn, os.Stdin, os.Stdout)
}

// Listens on 127.0.0.1:port and relays each accepted connection to the
// tunnel value's destination.
func forward(port, value string) error {
	dial, err := tunnelDialer(value)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		return err
	}
	defer listener.Close()
	for {
		local, err := listener.Accept()
		if err != nil {
			return err
		}
		go func() {
			defer local.Close()
			conn, err := dial()
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
			} else {
				defer conn.Close()
				relay(conn, local, local)
			}
		}()
	}
}
